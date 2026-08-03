"""Render a recorded command transcript back into geometry.

Without hardware, the only way to know whether what left Illustrator is what the
cutter would actually do is to decode the byte stream and look at it. This module
parses the transcript that ``SilhouetteCameo(cmdfile=...)`` records and turns it
back into paths, which can then be compared against the input or written out as
an SVG for eyeballing.

The device's axes are swapped relative to ours: the driver emits ``M<y>,<x>``
(see ``Graphtec.plot_cmds``), in Silhouette units of 1/20 mm. Everything this
module returns is back in (x_mm, y_mm).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterator

CMD_ETX = b"\x03"
SU_PER_MM = 20.0

#: Commands that carry pen-down/pen-up geometry. Everything else is setup.
_MOVE = "M"
_DRAW = "D"

_COORD_CMD = re.compile(r"^([MD])(-?\d+),(-?\d+)$")


@dataclass
class SimulatedCut:
    """Geometry decoded from a transcript, in mm."""

    paths: list[list[tuple[float, float]]] = field(default_factory=list)
    #: Commands that were not recognised, for diagnostics.
    unknown: list[str] = field(default_factory=list)
    #: Every non-geometry command, in order — useful for asserting setup sequences.
    setup_commands: list[str] = field(default_factory=list)

    @property
    def point_count(self) -> int:
        return sum(len(p) for p in self.paths)

    def bbox(self) -> tuple[float, float, float, float] | None:
        """(min_x, min_y, max_x, max_y) in mm, or None when nothing was drawn."""
        pts = [p for path in self.paths for p in path]
        if not pts:
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return (min(xs), min(ys), max(xs), max(ys))


def iter_commands(transcript: bytes) -> Iterator[str]:
    """Split a transcript into individual commands."""
    for chunk in transcript.split(CMD_ETX):
        text = chunk.decode("ascii", errors="replace").strip()
        if text:
            yield text


def parse(transcript: bytes) -> SimulatedCut:
    """Decode a transcript into paths.

    A ``M`` starts a new path (pen up, then down at the destination); each
    following ``D`` extends it. That mirrors how ``plot_cmds`` emits geometry.
    """
    result = SimulatedCut()
    current: list[tuple[float, float]] = []

    for cmd in iter_commands(transcript):
        match = _COORD_CMD.match(cmd)
        if not match:
            result.setup_commands.append(cmd)
            continue

        kind, raw_y, raw_x = match.groups()
        # Swap back: the wire carries (y, x).
        point = (int(raw_x) / SU_PER_MM, int(raw_y) / SU_PER_MM)

        if kind == _MOVE:
            if len(current) >= 2:
                result.paths.append(current)
            current = [point]
        else:  # _DRAW
            if not current:
                # A draw with no preceding move: the head was already positioned.
                result.unknown.append(cmd)
                current = [point]
            else:
                current.append(point)

    if len(current) >= 2:
        result.paths.append(current)

    return result


def to_svg(cut: SimulatedCut, width_mm: float, height_mm: float) -> str:
    """Render decoded geometry as an SVG string for visual inspection.

    Pen-down strokes only — travel moves between paths are not drawn, matching
    what the blade actually cuts.
    """
    w = f"{width_mm:g}"
    h = f"{height_mm:g}"
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{w}mm" height="{h}mm" viewBox="0 0 {w} {h}">',
        f'<rect width="{w}" height="{h}" fill="white"/>',
        '<g fill="none" stroke="black" stroke-width="0.2" '
        'stroke-linecap="round" stroke-linejoin="round">',
    ]
    for path in cut.paths:
        d = "M " + " L ".join(f"{x:.3f},{y:.3f}" for x, y in path)
        parts.append(f'<path d="{d}"/>')
    parts.append("</g></svg>")
    return "\n".join(parts)


def normalise_transcript(transcript: bytes) -> str:
    """A stable, readable form of a transcript for snapshot testing.

    One command per line with the ETX delimiters removed, so a snapshot diff
    points at the exact command that changed rather than at a wall of bytes.
    """
    return "\n".join(iter_commands(transcript)) + "\n"
