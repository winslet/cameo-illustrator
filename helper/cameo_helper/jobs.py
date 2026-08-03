"""Turn polylines from Illustrator into a cut on the device.

The whole reason this project is tractable is that the vendored driver's entry
point is a plain list of points::

    dev.plot(pathlist=[[(x_mm, y_mm), ...], ...], mediawidth=..., mediaheight=...)

so nothing here needs to know about SVG, Illustrator, or the wire protocol.
"""

from __future__ import annotations

import io
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from . import driver

Polyline = Sequence[Sequence[float]]
ProgressCallback = Callable[[int, int, str], None]


class JobCancelled(Exception):
    """Raised out of the progress callback to abort a running plot."""


@dataclass
class CutParams:
    """Everything the panel can ask for in one job.

    Defaults match the driver's own defaults so that omitting a field from the
    RPC request behaves the same as not passing it to the driver.
    """

    paths: list[Polyline] = field(default_factory=list)

    # Media geometry, in mm.
    media_width: float = 210.0
    media_height: float = 297.0
    offset_x: float = 0.0
    offset_y: float = 0.0

    # Tool settings. None means "take the media preset's value".
    media: int = 132
    speed: int | None = None
    pressure: int | None = None
    depth: int | None = None
    toolholder: int = 1
    pen: bool | None = None
    cutting_mat: str | None = None
    blade_diameter: float = 0.9
    autoblade: bool = False
    sharpen_corners: bool = False
    track_enhancing: bool = False

    # Job behaviour.
    passes: int = 1
    matless: bool = False
    matless_preset: str = "default"
    bbox_only: bool = False
    end_position: str = "below"
    end_paper_offset: float = 0.0

    # Dry run / simulation.
    dry_run: bool = False
    force_hardware: str | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "CutParams":
        """Build from an RPC payload, ignoring unknown keys.

        Ignoring rather than rejecting unknown keys keeps an older helper working
        against a newer panel, which matters because the two are installed
        together but can be updated separately.
        """
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in raw.items() if k in known})

    def validate(self) -> None:
        if not self.paths:
            raise ValueError("Nothing to cut: the path list is empty.")
        if self.passes < 1:
            raise ValueError("passes must be at least 1.")
        if self.end_position not in ("below", "start"):
            raise ValueError("end_position must be 'below' or 'start'.")
        for name in ("media_width", "media_height"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive.")


@dataclass
class CutResult:
    #: Flat mm extents of what was cut: llx/urx/lly/ury. See `_flatten_bbox`.
    bbox: dict[str, Any]
    device: str
    path_count: int
    point_count: int
    transcript: bytes
    cancelled: bool = False


def _flatten_bbox(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Pull the useful extents out of what `plot()` returns.

    `plot()` hands back `{'bbox': {...}, 'unit': ..., 'trailer': [...]}`, where
    the inner dict also carries bookkeeping ('clip', 'count', 'only') that means
    nothing to a caller. Flattening it here keeps that shape from leaking into
    the RPC contract and the panel.

    Note the driver's naming is not a conventional lower-left/upper-right pair:
    y runs downward, so `ury` is the *top* edge and `lly` the bottom.
    """
    if not raw:
        return {}

    inner = raw.get("bbox", raw)
    if not isinstance(inner, dict):
        return {}

    keys = ("llx", "urx", "lly", "ury")
    if not all(k in inner for k in keys):
        return {}

    return {
        "llx": inner["llx"],
        "urx": inner["urx"],
        "lly": inner["lly"],
        "ury": inner["ury"],
        "width_mm": inner["urx"] - inner["llx"],
        "height_mm": inner["lly"] - inner["ury"],
        "point_count": inner.get("count", 0),
    }


def _normalise(paths: Sequence[Polyline]) -> list[list[tuple[float, float]]]:
    """Coerce incoming JSON into the tuple-of-floats shape the driver expects.

    JSON gives us lists, and `MatFree` may hand back 3-element points carrying
    an attribute dict, so we take only the first two components.
    """
    out = []
    for path in paths:
        pts = [(float(p[0]), float(p[1])) for p in path]
        if len(pts) >= 2:
            out.append(pts)
    return out


def run_cut(
    params: CutParams,
    progress_cb: ProgressCallback | None = None,
    cancel_event: threading.Event | None = None,
) -> CutResult:
    """Run one cut job, start to finish.

    Returns the bounding box the driver computed plus the full byte transcript,
    which is what the simulator renders and what the snapshot tests compare.
    """
    driver.require()
    params.validate()

    paths = _normalise(params.paths)
    if not paths:
        raise ValueError("Nothing to cut: every path had fewer than two points.")

    if params.matless:
        # MatFree reorders cuts so the material is never pulled apart by a cut
        # upstream of where the blade still has to travel.
        strategy = driver.MatFree(
            params.matless_preset, scale=1.0, pen=bool(params.pen)
        )
        with driver.quiet_stdout():
            paths = _normalise(strategy.apply(paths))

    # A pass is a repeat of the whole design. Repeating within a single plot()
    # call rather than calling plot() per pass keeps the media stationary between
    # passes — otherwise end-of-job media movement would destroy registration.
    pathlist = paths * params.passes

    transcript = io.BytesIO()

    def _on_progress(done: int, total: int, flags: str = "") -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise JobCancelled()
        if progress_cb is not None:
            progress_cb(done, total, flags)

    cancelled = False
    with driver.quiet_stdout():
        dev = driver.SilhouetteCameo(
            cmdfile=transcript,
            dry_run=params.dry_run,
            force_hardware=params.force_hardware,
            progress_cb=_on_progress,
        )

        dev.setup(
            media=params.media,
            speed=params.speed,
            pressure=params.pressure,
            depth=params.depth,
            toolholder=params.toolholder,
            pen=params.pen,
            cuttingmat=params.cutting_mat,
            sharpencorners=params.sharpen_corners,
            autoblade=params.autoblade,
            trackenhancing=params.track_enhancing,
            bladediameter=params.blade_diameter,
            mediawidth=params.media_width,
            mediaheight=params.media_height,
        )

        try:
            bbox = dev.plot(
                pathlist=pathlist,
                mediawidth=params.media_width,
                mediaheight=params.media_height,
                offset=(params.offset_x, params.offset_y),
                bboxonly=params.bbox_only,
                endposition=params.end_position,
                end_paper_offset=params.end_paper_offset,
            )
        except JobCancelled:
            cancelled = True
            bbox = {}
            # Leaving the head wherever it stopped would make the next job start
            # from an unknown origin, so send it home before giving up.
            try:
                dev.send_command("H")
            except Exception:
                pass

        device_name = getattr(dev, "hardware", {}).get("name", "unknown")

    return CutResult(
        bbox=_flatten_bbox(bbox),
        device=device_name,
        path_count=len(paths),
        point_count=sum(len(p) for p in paths),
        transcript=transcript.getvalue(),
        cancelled=cancelled,
    )


def probe_device(force_hardware: str | None = None) -> dict[str, Any]:
    """Look for an attached cutter and report what it says about itself.

    Runs as a dry run so that merely opening the panel never moves the machine.
    """
    driver.require()
    with driver.quiet_stdout():
        dev = driver.SilhouetteCameo(dry_run=True, force_hardware=force_hardware)
        hardware = getattr(dev, "hardware", {}) or {}
        connected = getattr(dev, "transport", None) is not None

        status = None
        if connected:
            try:
                status = dev.status()
            except Exception as exc:
                status = f"error: {exc}"

    return {
        "connected": connected,
        "name": hardware.get("name", "unknown"),
        "label": str(hardware.get("name", "unknown")).replace("_", " "),
        "width_mm": hardware.get("width_mm"),
        "length_mm": hardware.get("length_mm"),
        "regmark": bool(hardware.get("regmark", False)),
        "max_pressure": hardware.get("max_pressure", 33),
        "status": status,
    }
