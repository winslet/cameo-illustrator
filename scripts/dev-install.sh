#!/usr/bin/env bash
# Install the panel into Illustrator for development.
#
# Symlinks the extension rather than copying, so edits show up on panel reload
# without reinstalling. Enables CEP's debug mode, which is required for any
# extension that is not signed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_ID="com.samwinslet.cameo-illustrator"
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
TARGET="$EXT_DIR/$EXT_ID"

if [[ "$(uname)" != "Darwin" ]]; then
  # printf, not echo: echo mangles the backslashes in the Windows paths.
  printf '%s\n' \
    "This script is macOS-only. On Windows, set PlayerDebugMode=1 under" \
    "HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.<n> and copy cep/ into" \
    "%APPDATA%\\Adobe\\CEP\\extensions\\$EXT_ID." >&2
  exit 1
fi

echo "==> Enabling CEP debug mode"
# Unsigned extensions only load with PlayerDebugMode set. The CSXS version
# differs per Illustrator release, so set it for every version present plus the
# ones this panel targets.
for version in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$version" PlayerDebugMode 1 2>/dev/null || true
done
defaults read com.adobe.CSXS.12 PlayerDebugMode >/dev/null 2>&1 \
  && echo "    CSXS.12 PlayerDebugMode = $(defaults read com.adobe.CSXS.12 PlayerDebugMode)"

echo "==> Linking the helper into the extension"
"$REPO_ROOT/scripts/link-helper.sh"

echo "==> Creating the .debug file"
# Lets you attach Chrome DevTools at http://localhost:8{ the port below }.
cat > "$REPO_ROOT/cep/.debug" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="$EXT_ID.panel">
    <HostList>
      <Host Name="ILST" Port="8088"/>
    </HostList>
  </Extension>
</ExtensionList>
EOF

echo "==> Linking the extension"
mkdir -p "$EXT_DIR"
if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
  echo "    $TARGET exists and is not a symlink; refusing to replace it." >&2
  exit 1
fi
ln -sfn "$REPO_ROOT/cep" "$TARGET"
echo "    $TARGET -> $REPO_ROOT/cep"

echo "==> Checking the Python environment"
if [[ ! -x "$REPO_ROOT/.venv/bin/python3" ]]; then
  echo "    No .venv found. Creating one."
  python3 -m venv "$REPO_ROOT/.venv"
  "$REPO_ROOT/.venv/bin/pip" install -q --upgrade pip
  "$REPO_ROOT/.venv/bin/pip" install -q pyusb libusb1 libusb pytest
fi

# Vendored packages carry their own libusb, so there is no Homebrew step and
# development matches what ships. Cheap to redo, so always refresh it.
if [[ ! -d "$REPO_ROOT/helper/vendor/pydeps" ]]; then
  "$REPO_ROOT/scripts/vendor-pydeps.sh"
fi

echo "==> Verifying the helper runs"
if PYTHONPATH="$REPO_ROOT/helper" "$REPO_ROOT/.venv/bin/python3" -m cameo_helper --selftest >/dev/null 2>&1; then
  echo "    helper OK"
else
  echo "    WARNING: the helper selftest failed. Run it directly to see why:" >&2
  echo "      PYTHONPATH=helper .venv/bin/python3 -m cameo_helper --selftest" >&2
fi

cat <<'EOF'

Done. Now:
  1. Quit Illustrator completely, then reopen it.
  2. Window > Extensions > Send to Silhouette
  3. To debug the panel, open http://localhost:8088 in Chrome.
EOF
