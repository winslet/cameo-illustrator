"""Byte-stream snapshots for every model the driver knows.

`force_hardware` lets us drive any model in the DEVICE table without owning it,
and `dry_run` + `cmdfile` records exactly what would go down the wire. So the
same fixture design is rendered for all 19 models and the transcript snapshotted.

This is what "compatible with as many devices as possible" means in practice: if
re-syncing the vendored driver changes behaviour for a model, the diff names the
model and the exact command that changed, rather than being discovered by a user
with hardware we do not have.

Refresh snapshots after an intentional change with:

    pytest helper/tests/test_devices.py --snapshot-update
"""

import pytest

from cameo_helper import driver, jobs, simulator

SNAPSHOT_DIR = "snapshots"

ALL_MODELS = [d["name"] for d in driver.device_catalog()] if driver.available() else []


def pytest_generate_tests(metafunc):
    if "model" in metafunc.fixturenames:
        metafunc.parametrize("model", ALL_MODELS)


@pytest.fixture
def fixture_design():
    """Exercises a closed shape, an open path, and a diagonal in one design."""
    return [
        [(10.0, 10.0), (30.0, 10.0), (30.0, 30.0), (10.0, 30.0), (10.0, 10.0)],
        [(40.0, 10.0), (60.0, 30.0)],
        [(40.0, 30.0), (50.0, 40.0), (60.0, 30.0)],
    ]


def test_model_produces_stable_transcript(model, fixture_design, request, snapshot_path):
    result = jobs.run_cut(
        jobs.CutParams(
            paths=fixture_design,
            dry_run=True,
            force_hardware=model,
            media=132,
            media_width=210.0,
            media_height=297.0,
        )
    )
    actual = simulator.normalise_transcript(result.transcript)
    path = snapshot_path(f"{model}.txt")

    if request.config.getoption("--snapshot-update") or not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(actual)
        pytest.skip(f"snapshot written: {path.name}")

    expected = path.read_text()
    assert actual == expected, (
        f"Wire protocol changed for {model}. If this is intentional, re-run with "
        f"--snapshot-update and review the diff carefully — it changes what real "
        f"hardware receives."
    )


def test_every_model_round_trips_geometry(model, fixture_design):
    """The design's shape must survive on every model, at its exact size.

    Placement is deliberately *not* asserted here: the driver shifts a design by
    the machine's physical media margins, which differ per model. That is
    covered by test_placement_matches_device_margins.
    """
    result = jobs.run_cut(
        jobs.CutParams(paths=fixture_design, dry_run=True, force_hardware=model)
    )
    decoded = simulator.parse(result.transcript)

    assert len(decoded.paths) == len(fixture_design)
    min_x, min_y, max_x, max_y = decoded.bbox()
    assert (max_x - min_x) == pytest.approx(50.0)
    assert (max_y - min_y) == pytest.approx(30.0)


def test_placement_matches_device_margins(model, fixture_design):
    """A design lands offset by exactly the machine's media margins.

    This is why the same file cuts in a different place on different machines:
    an original Cameo has margin_left_mm 9.0, the Cameo 5 family -6.0. Pinning it
    here means a vendor re-sync that changes a margin shows up as a named test
    failure rather than as a misplaced cut on someone's material.
    """
    hardware = next(d for d in driver.device_catalog() if d["name"] == model)
    result = jobs.run_cut(
        jobs.CutParams(paths=fixture_design, dry_run=True, force_hardware=model)
    )
    decoded = simulator.parse(result.transcript)

    min_x, min_y, _, _ = decoded.bbox()
    assert min_x == pytest.approx(10.0 + hardware["margin_left_mm"])
    assert min_y == pytest.approx(10.0 + hardware["margin_top_mm"])


def test_no_unknown_commands_are_emitted(model, fixture_design):
    """A draw with no preceding move would mean we mis-modelled the dialect."""
    result = jobs.run_cut(
        jobs.CutParams(paths=fixture_design, dry_run=True, force_hardware=model)
    )
    decoded = simulator.parse(result.transcript)

    assert decoded.unknown == []


def test_catalog_covers_the_driver_table():
    """Guard against the catalog silently shrinking after a vendor re-sync."""
    assert len(ALL_MODELS) == len(driver.DEVICE)
    assert len(ALL_MODELS) >= 19
    assert len(set(ALL_MODELS)) == len(ALL_MODELS), "duplicate model names"
