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

    captured["progress_cb"](32, 128, "")
    assert seen == [(32, 128, "")]


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
