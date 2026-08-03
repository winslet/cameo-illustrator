"""Job plumbing: parameter handling, bbox shape, progress and cancellation."""

import threading

import pytest

from cameo_helper import jobs


def test_unknown_params_are_ignored():
    """An older helper must not fall over on a field a newer panel sends."""
    params = jobs.CutParams.from_dict(
        {"paths": [[(0, 0), (1, 1)]], "passes": 2, "future_option": True}
    )

    assert params.passes == 2
    assert not hasattr(params, "future_option")


def test_validation_rejects_nonsense():
    with pytest.raises(ValueError, match="passes"):
        jobs.CutParams(paths=[[(0, 0), (1, 1)]], passes=0).validate()
    with pytest.raises(ValueError, match="end_position"):
        jobs.CutParams(paths=[[(0, 0), (1, 1)]], end_position="sideways").validate()
    with pytest.raises(ValueError, match="media_width"):
        jobs.CutParams(paths=[[(0, 0), (1, 1)]], media_width=0).validate()


def test_bbox_is_flattened(square):
    result = jobs.run_cut(jobs.CutParams(paths=square, dry_run=True))

    # The driver's own nested shape must not leak through.
    assert "bbox" not in result.bbox
    assert result.bbox["llx"] == pytest.approx(10.0)
    assert result.bbox["urx"] == pytest.approx(30.0)
    assert result.bbox["width_mm"] == pytest.approx(20.0)
    assert result.bbox["height_mm"] == pytest.approx(20.0)


def test_flatten_bbox_tolerates_missing_data():
    """A cancelled or empty job returns no usable extents rather than KeyError."""
    assert jobs._flatten_bbox(None) == {}
    assert jobs._flatten_bbox({}) == {}
    assert jobs._flatten_bbox({"bbox": {"only": False}}) == {}


def test_progress_callback_is_forwarded(square, monkeypatch):
    """The callback the driver invokes must reach our caller unchanged.

    The driver only reports progress from inside its USB write loop, which a dry
    run skips, so the callback is exercised directly here rather than by cutting.
    """
    seen = []
    captured = {}

    original = jobs.driver.SilhouetteCameo

    def capture(*args, **kwargs):
        captured["progress_cb"] = kwargs.get("progress_cb")
        return original(*args, **kwargs)

    monkeypatch.setattr(jobs.driver, "SilhouetteCameo", capture)
    jobs.run_cut(
        jobs.CutParams(paths=square, dry_run=True),
        progress_cb=lambda done, total, flags: seen.append((done, total, flags)),
    )

    # The job itself now reports real progress (see the patch in
    # cameo_helper.patches), so isolate the manual call from those.
    seen.clear()
    captured["progress_cb"](32, 128, "t")
    assert seen == [(32, 128, "t")]


def test_cancellation_raises_out_of_the_callback(square, monkeypatch):
    """A set cancel event must abort the plot via the progress callback."""
    captured = {}
    original = jobs.driver.SilhouetteCameo

    def capture(*args, **kwargs):
        captured["progress_cb"] = kwargs.get("progress_cb")
        return original(*args, **kwargs)

    monkeypatch.setattr(jobs.driver, "SilhouetteCameo", capture)

    event = threading.Event()
    jobs.run_cut(jobs.CutParams(paths=square, dry_run=True), cancel_event=event)

    event.set()
    with pytest.raises(jobs.JobCancelled):
        captured["progress_cb"](1, 100, "")


def _long_design(count=300):
    return [[(10.0, 10.0 + i * 0.4), (100.0, 10.0 + i * 0.4)] for i in range(count)]


def test_progress_is_reported_while_plotting():
    """Regression: progress was never reported for the actual cut.

    plot() sends geometry via safe_write in <=1024-byte packets, but write()
    only reported from a 4096-byte chunk loop that also skipped its first pass —
    so a packet produced exactly one iteration with o == 0 and no callback ever
    fired. The bar sat still for the whole job. See cameo_helper.patches.
    """
    events = []
    jobs.run_cut(
        jobs.CutParams(paths=_long_design(), dry_run=True),
        progress_cb=lambda done, total, flags: events.append((done, total)),
    )

    assert len(events) > 1, "no progress reported during the plot"


def test_progress_is_monotonic_and_bounded():
    """A bar that jumps backwards or past 100% reads as broken.

    safe_write polls the device between packets, and those status queries go
    through write() too — counting them pushed `done` past `total`.
    """
    events = []
    jobs.run_cut(
        jobs.CutParams(paths=_long_design(), dry_run=True),
        progress_cb=lambda done, total, flags: events.append((done, total)),
    )

    done = [d for d, _ in events]
    assert done == sorted(done), f"progress went backwards: {done}"
    assert all(d <= t for d, t in events), f"progress exceeded total: {events}"
    assert events[-1][0] == events[-1][1], "did not finish at 100%"


def test_cancel_stops_the_job_partway():
    """Cancel must actually stop sending, not just set a flag at the end."""
    full = jobs.run_cut(jobs.CutParams(paths=_long_design(), dry_run=True))

    cancel = threading.Event()
    cancel.set()
    cancelled = jobs.run_cut(
        jobs.CutParams(paths=_long_design(), dry_run=True), cancel_event=cancel
    )

    assert cancelled.cancelled is True
    assert len(cancelled.transcript) < len(full.transcript), (
        "cancelling sent as many bytes as a full job — it did not stop early"
    )


def test_pen_is_inferred_from_the_media_preset():
    """Media 113 is a pen, and MatFree must be told before it reorders.

    The driver infers this in setup(), which runs after the strategy. Coercing
    an unset value would make MatFree extend every stroke by its 0.2mm blade
    overshoot — correct for a blade, visible ink past the corners for a pen.
    """
    assert _pen_for(media=113) is True
    assert _pen_for(media=132) is False

    # An explicit setting always wins over the media default.
    assert _pen_for(media=113, pen=False) is False
    assert _pen_for(media=132, pen=True) is True


def _pen_for(media, pen=None):
    return jobs._resolve_pen(jobs.CutParams(paths=[[(0, 0), (1, 1)]], media=media, pen=pen))


def test_pen_media_suppresses_matless_overshoot():
    """The user-visible consequence of the pen inference above."""
    shapes = [
        [(10.0, 10.0), (30.0, 10.0), (30.0, 30.0), (10.0, 30.0), (10.0, 10.0)],
        [(50.0, 50.0), (70.0, 50.0), (60.0, 70.0), (50.0, 50.0)],
    ]
    blade = jobs.run_cut(
        jobs.CutParams(paths=shapes, dry_run=True, matless=True, media=132)
    )
    pen = jobs.run_cut(
        jobs.CutParams(paths=shapes, dry_run=True, matless=True, media=113)
    )

    blade_w = blade.bbox["width_mm"]
    pen_w = pen.bbox["width_mm"]
    assert pen_w < blade_w, (
        f"pen media should not overshoot: pen {pen_w} vs blade {blade_w}"
    )


def test_paths_accept_lists_as_well_as_tuples():
    """JSON gives lists; the driver wants points it can index. Both must work."""
    result = jobs.run_cut(
        jobs.CutParams(paths=[[[10, 10], [30, 10], [30, 30]]], dry_run=True)
    )

    assert result.path_count == 1
    assert result.point_count == 3


def test_extra_point_components_are_tolerated():
    """MatFree emits [x, y, attrs]; only the coordinates should be used."""
    paths = [[[10, 10, {"sharp": True}], [30, 10, {}], [30, 30, {}]]]
    result = jobs.run_cut(jobs.CutParams(paths=paths, dry_run=True))

    assert result.bbox["width_mm"] == pytest.approx(20.0)
