"""Geometry must survive the trip out to the wire and back.

These are the tests that catch the defects most likely to actually happen:
unit errors, the x/y swap the device requires, and off-by-a-margin offsets.
"""

import pytest

from cameo_helper import jobs, simulator


def _cut(paths, **kwargs):
    result = jobs.run_cut(jobs.CutParams(paths=paths, dry_run=True, **kwargs))
    return result, simulator.parse(result.transcript)


def test_square_survives_roundtrip(square):
    _, decoded = _cut(square)

    assert len(decoded.paths) == 1
    assert decoded.bbox() == pytest.approx((10.0, 10.0, 30.0, 30.0))


def test_points_match_exactly(square):
    """At 20 units/mm, coordinates on 0.05mm boundaries must be lossless."""
    _, decoded = _cut(square)

    assert decoded.paths[0] == pytest.approx(square[0])


def test_axes_are_not_transposed():
    """A wide, short rectangle must not come back tall and narrow.

    The driver emits M<y>,<x>; if the simulator (or a future transport) got that
    backwards, a square would still pass but this will not.
    """
    wide = [[(10.0, 10.0), (90.0, 10.0), (90.0, 20.0), (10.0, 20.0), (10.0, 10.0)]]
    _, decoded = _cut(wide)

    min_x, min_y, max_x, max_y = decoded.bbox()
    assert max_x - min_x == pytest.approx(80.0)
    assert max_y - min_y == pytest.approx(10.0)


def test_offset_shifts_geometry(square):
    _, plain = _cut(square)
    _, shifted = _cut(square, offset_x=5.0, offset_y=7.0)

    px0, py0, px1, py1 = plain.bbox()
    sx0, sy0, sx1, sy1 = shifted.bbox()
    assert (sx0 - px0, sy0 - py0) == pytest.approx((5.0, 7.0))
    assert (sx1 - px1, sy1 - py1) == pytest.approx((5.0, 7.0))


def test_separate_paths_stay_separate(two_shapes):
    """Travel between paths must be pen-up, not a cut across the material."""
    _, decoded = _cut(two_shapes)

    assert len(decoded.paths) == 2
    assert len(decoded.paths[0]) == 5
    assert len(decoded.paths[1]) == 4


def test_passes_repeat_the_whole_design(square):
    _, once = _cut(square, passes=1)
    _, thrice = _cut(square, passes=3)

    assert len(thrice.paths) == 3 * len(once.paths)
    # Repeating must not move the design.
    assert thrice.bbox() == pytest.approx(once.bbox())


def test_bbox_only_draws_a_rectangle():
    """bbox_only is the cheap dry run on scrap; it must not cut the design.

    Uses a triangle rather than a square, because a square is indistinguishable
    from its own bounding box and would pass even if the design were cut.
    """
    triangle = [[(10.0, 10.0), (50.0, 10.0), (30.0, 40.0), (10.0, 10.0)]]
    result, decoded = _cut(triangle, bbox_only=True)

    assert len(decoded.paths) == 1
    # A closed rectangle: 5 points, the last repeating the first.
    assert len(decoded.paths[0]) == 5
    assert decoded.bbox() == pytest.approx((10.0, 10.0, 50.0, 40.0))
    # The triangle's apex at x=30 must not appear as a cut vertex.
    assert (30.0, 40.0) not in decoded.paths[0]


def test_degenerate_paths_are_dropped():
    """A single-point path has nothing to cut and must not reach the device."""
    with pytest.raises(ValueError, match="fewer than two points"):
        _cut([[(10.0, 10.0)]])


def test_empty_pathlist_is_rejected():
    with pytest.raises(ValueError, match="path list is empty"):
        _cut([])


def test_matless_preserves_the_design_envelope(two_shapes):
    """MatFree reorders and subdivides cuts, but must not move or lose them.

    The envelope grows slightly because the strategy deliberately overshoots the
    end of each cut so that interrupted cuts overlap rather than leaving an uncut
    sliver. 0.5mm is comfortably above the default overshoot and far below any
    real placement error.
    """
    _, plain = _cut(two_shapes)
    _, matless = _cut(two_shapes, matless=True)

    assert matless.bbox() == pytest.approx(plain.bbox(), abs=0.5)
    assert matless.point_count >= plain.point_count


def test_matless_survives_disjoint_shapes(two_shapes):
    """Regression test for the upstream MatFree crash.

    Two disjoint shapes produce a barrier slice with no segments, which made
    Strategy.decide_left2right compare None against a float. See
    cameo_helper.patches. Without the patch this raises TypeError.
    """
    _, decoded = _cut(two_shapes, matless=True)

    assert len(decoded.paths) >= 2


def test_svg_preview_contains_the_geometry(square):
    _, decoded = _cut(square)
    svg = simulator.to_svg(decoded, 210.0, 297.0)

    assert svg.startswith("<svg")
    assert svg.count("<path") == 1
    assert "210mm" in svg and "297mm" in svg
