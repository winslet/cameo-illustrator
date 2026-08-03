"""Access to the vendored inkscape-silhouette driver.

Everything awkward about talking to the vendored GPL code is contained here so
the rest of the helper can stay clean:

* the ``sys.path`` insertion that makes ``from silhouette.Transport import ...``
  resolve against ``helper/vendor``,
* the import failing when libusb is missing, which must not take the process down,
* stray ``print()`` calls in the driver, which would corrupt our JSON-lines
  protocol on stdout.
"""

from __future__ import annotations

import contextlib
import os
import sys
from typing import Any

_VENDOR_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor"
)
if _VENDOR_DIR not in sys.path:
    sys.path.insert(0, _VENDOR_DIR)

# Vendored third-party packages (pyusb, libusb1, and a libusb wheel carrying
# prebuilt native libraries). Present in a packaged build and after running
# scripts/vendor-pydeps.sh; absent in a bare checkout, where the virtualenv
# supplies them instead. Inserted ahead of the vendored driver so the native
# library that ships with us wins over any system copy.
_PYDEPS_DIR = os.path.join(_VENDOR_DIR, "pydeps")
if os.path.isdir(_PYDEPS_DIR) and _PYDEPS_DIR not in sys.path:
    sys.path.insert(0, _PYDEPS_DIR)

#: Populated with the exception when the driver could not be imported. The helper
#: still starts in that case and reports the reason over RPC, so the panel can show
#: something better than a dead process.
IMPORT_ERROR: Exception | None = None

try:
    from silhouette.Graphtec import (  # type: ignore[import-not-found]
        CAMEO_MATS,
        DEVICE,
        MEDIA,
        SilhouetteCameo,
    )
    from silhouette.Strategy import MatFree  # type: ignore[import-not-found]

    from . import patches

    APPLIED_PATCHES = patches.apply_all()
except Exception as exc:  # pragma: no cover - depends on the host machine
    IMPORT_ERROR = exc
    CAMEO_MATS = {}
    DEVICE = []
    MEDIA = []
    APPLIED_PATCHES = []
    SilhouetteCameo = None  # type: ignore[assignment]
    MatFree = None  # type: ignore[assignment]


def available() -> bool:
    """True when the driver imported and can be used."""
    return IMPORT_ERROR is None


def require() -> None:
    """Raise a useful error if the driver is unusable."""
    if IMPORT_ERROR is not None:
        raise RuntimeError(
            f"The Silhouette driver could not be loaded: {IMPORT_ERROR}. "
            "On macOS this usually means libusb is missing — install it with "
            "'brew install libusb', then restart Illustrator."
        )


@contextlib.contextmanager
def quiet_stdout():
    """Redirect stdout to stderr for the duration of the block.

    The vendored driver prints progress and diagnostics to stdout in places, and
    stdout is our JSON-lines RPC channel. A single stray print would desync the
    panel, so every call into the driver goes through here.
    """
    with contextlib.redirect_stdout(sys.stderr):
        yield


def device_catalog() -> list[dict[str, Any]]:
    """The full table of models the driver knows how to drive.

    Used by the panel both to show what is supported and to populate the
    "pretend to be this model" picker used for dry runs without hardware.
    """
    catalog = []
    for hw in DEVICE:
        catalog.append(
            {
                "name": hw["name"],
                "label": hw["name"].replace("_", " "),
                "vendor_id": hw.get("vendor_id"),
                "product_id": hw.get("product_id"),
                "width_mm": hw.get("width_mm"),
                "length_mm": hw.get("length_mm"),
                # Physical media margins. These shift where a design actually
                # lands: the same artwork sits 9mm right of nominal on an
                # original Cameo and 6mm left on a Cameo 5. The panel shows this
                # so the offset is not a surprise on the material.
                "margin_left_mm": hw.get("margin_left_mm", 0.0),
                "margin_top_mm": hw.get("margin_top_mm", 0.0),
                "regmark": bool(hw.get("regmark", False)),
                "quadregmarks": bool(hw.get("quadregmarks", False)),
                "max_pressure": hw.get("max_pressure", 33),
            }
        )
    return catalog


def cutting_mats() -> list[str]:
    """Keys accepted by ``SilhouetteCameo.setup(cuttingmat=...)``."""
    return sorted(str(k) for k in CAMEO_MATS)


def media_catalog() -> list[dict[str, Any]]:
    """The material presets the cutter itself knows about.

    Read straight from the driver's ``MEDIA`` table rather than duplicated into a
    JSON file of our own, so it cannot drift out of sync when the vendored driver
    is re-synced. Media code 300 is the sentinel for "use my explicit
    pressure/speed/depth" and is surfaced as ``custom``.

    ``cap_color`` is the colour of the blade cap Silhouette recommends for the
    material; the panel shows it as a swatch.
    """
    catalog = []
    for code, pressure, speed, depth, cap_color, name in MEDIA:
        catalog.append(
            {
                "code": code,
                "name": name,
                "custom": code == 300,
                "pressure": pressure,
                "speed": speed,
                "depth": depth,
                "cap_color": cap_color,
            }
        )
    return catalog
