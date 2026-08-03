#!/usr/bin/env bash
# Vendor the helper's Python dependencies into helper/vendor/pydeps.
#
# This is what removes the "brew install libusb" step. pyusb, libusb1 and libusb
# are all py3-none-any wheels — pure Python, so one vendored copy works on any
# Python 3 — and the `libusb` wheel carries prebuilt native libraries for macOS,
# Windows and Linux.
#
# usb1 looks for the native library in its own package directory before
# anywhere else (see usb1/_libusb1.py), so the dylib is placed there.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$REPO_ROOT/helper/vendor/pydeps"
PYTHON="${PYTHON:-$REPO_ROOT/.venv/bin/python3}"

if [[ ! -x "$PYTHON" ]]; then
  PYTHON="$(command -v python3)"
fi
[[ -x "$PYTHON" ]] || { echo "No python3 found. Set PYTHON=/path/to/python3." >&2; exit 1; }

echo "==> Vendoring Python dependencies with $PYTHON"
rm -rf "$TARGET"
mkdir -p "$TARGET"

# --no-deps matters: the `libusb` wheel declares build-time dependencies that
# pip would otherwise install as compiled, interpreter-specific artefacts,
# which would tie the vendored tree to one Python version.
"$PYTHON" -m pip install --quiet --target "$TARGET" --no-deps \
  pyusb libusb1 libusb

echo "==> Installing the native library where usb1 looks for it"
PLATFORM_DIR="$TARGET/libusb/_platform"

case "$(uname -s)" in
  Darwin)
    ARM="$PLATFORM_DIR/macos/arm64/libusb-1.0.dylib"
    INTEL="$PLATFORM_DIR/macos/x86_64/libusb-1.0.dylib"
    OUT="$TARGET/usb1/libusb-1.0.dylib"

    if [[ -f "$ARM" && -f "$INTEL" ]]; then
      # One universal binary so a single build runs on Apple Silicon and Intel.
      lipo -create "$ARM" "$INTEL" -output "$OUT"
      echo "    universal: $(lipo -archs "$OUT")"
    elif [[ -f "$ARM" || -f "$INTEL" ]]; then
      cp "$([[ -f "$ARM" ]] && echo "$ARM" || echo "$INTEL")" "$OUT"
      echo "    single arch: $(lipo -archs "$OUT")"
    else
      echo "    WARNING: no macOS libusb in the wheel; the helper will fall back" >&2
      echo "             to a system libusb if one is installed." >&2
    fi
    ;;
  Linux)
    # The wheel's directory names match uname -m (x86_64, aarch64, ...).
    # usb1 looks for libusb-1.0.so.0 before libusb-1.0.so, so use that name.
    ARCH="$(uname -m)"
    SRC="$PLATFORM_DIR/linux/$ARCH/libusb-1.0.so"
    if [[ -f "$SRC" ]]; then
      cp "$SRC" "$TARGET/usb1/libusb-1.0.so.0"
      echo "    linux/$ARCH"
    else
      echo "    WARNING: no bundled libusb for linux/$ARCH" >&2
    fi
    ;;
esac

# Trim build noise so the packaged extension stays small.
find "$TARGET" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$TARGET" -name "*.dist-info" -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo "==> Verifying the vendored tree loads without a system libusb"
if env -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH \
     PYTHONPATH="$TARGET" "$PYTHON" -c "
import usb1
ctx = usb1.USBContext(); ctx.open(); ctx.close()
" 2>/dev/null; then
  echo "    OK — libusb loads from the vendored copy"
else
  echo "    FAILED: the vendored libusb did not load." >&2
  exit 1
fi

echo "    size: $(du -sh "$TARGET" | cut -f1)"
