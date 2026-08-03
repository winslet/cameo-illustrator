import pathlib

import pytest

from cameo_helper import driver


def pytest_addoption(parser):
    parser.addoption(
        "--snapshot-update",
        action="store_true",
        default=False,
        help="rewrite per-model wire-protocol snapshots instead of comparing",
    )


@pytest.fixture
def snapshot_path(request):
    base = pathlib.Path(request.path).parent / "snapshots"
    return lambda name: base / name

# Every test here drives the vendored driver, which needs libusb present even for
# dry runs (Graphtec.py opens a libusb context at import time on macOS).
pytestmark = pytest.mark.skipif(
    not driver.available(), reason=f"driver unavailable: {driver.IMPORT_ERROR}"
)


@pytest.fixture
def square():
    """A 20mm square at (10,10). Closed: first point repeated at the end."""
    return [[(10.0, 10.0), (30.0, 10.0), (30.0, 30.0), (10.0, 30.0), (10.0, 10.0)]]


@pytest.fixture
def two_shapes():
    """Two disjoint paths, to exercise pen-up travel between them."""
    return [
        [(10.0, 10.0), (30.0, 10.0), (30.0, 30.0), (10.0, 30.0), (10.0, 10.0)],
        [(50.0, 50.0), (70.0, 50.0), (60.0, 70.0), (50.0, 50.0)],
    ]
