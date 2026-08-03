#!/usr/bin/env bash
# Build a signed, notarised .pkg — the one-click distribution tier.
#
# Unlike the .zxp, this bundles a Python runtime, so the user installs nothing
# else: double-click, reopen Illustrator, done. That convenience is exactly what
# costs money — a bundled interpreter is a compiled binary, so it needs an Apple
# Developer ID and notarisation or Gatekeeper refuses to run it.
#
#   scripts/build-installer.sh --unsigned    # build and verify the payload, no certs
#   scripts/build-installer.sh               # sign + notarise (needs certificates)
#
# Required for a real build:
#   SIGN_APP   "Developer ID Application: Your Name (TEAMID)"
#   SIGN_PKG   "Developer ID Installer: Your Name (TEAMID)"
#   KEYCHAIN_PROFILE   a notarytool profile name, created once with:
#       xcrun notarytool store-credentials <profile> \
#         --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-password>
#
# Note these are NOT the same certificates as an iOS distribution certificate.
# Create them under Certificates in your Apple Developer account; only the
# account holder can.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO_ROOT/dist"
WORK="$DIST/pkg-build"
TOOLS="$REPO_ROOT/.tools"
EXT_ID="com.samwinslet.cameo-illustrator"
PKG_ID="com.samwinslet.cameo-illustrator.installer"

PYTHON_VERSION="${PYTHON_VERSION:-3.12.13}"
PBS_RELEASE="${PBS_RELEASE:-20260728}"
PBS_BASE="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE"

# Installed system-wide. CEP reads this and the per-user directory; a .pkg
# writing to /Library is the conventional, reliable choice.
INSTALL_LOCATION="/Library/Application Support/Adobe/CEP/extensions"

UNSIGNED=0
[[ "${1:-}" == "--unsigned" ]] && UNSIGNED=1

VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' \
  "$REPO_ROOT/cep/CSXS/manifest.xml" | head -1)"
OUTPUT="$DIST/CameoForIllustrator-$VERSION.pkg"

# ---- prerequisites -------------------------------------------------------

if [[ $UNSIGNED -eq 0 ]]; then
  missing=0
  for var in SIGN_APP SIGN_PKG KEYCHAIN_PROFILE; do
    if [[ -z "${!var:-}" ]]; then
      echo "Missing $var." >&2
      missing=1
    fi
  done
  if [[ $missing -eq 1 ]]; then
    echo >&2
    echo "Available signing identities:" >&2
    security find-identity -v -p codesigning 2>/dev/null | sed 's/^/  /' >&2 || true
    echo >&2
    echo "Re-run with --unsigned to build and check the payload without signing." >&2
    exit 1
  fi
fi

# ---- payload -------------------------------------------------------------

echo "==> Staging payload"
rm -rf "$WORK"
PAYLOAD="$WORK/payload/$EXT_ID"
mkdir -p "$PAYLOAD"

rsync -a --exclude '.debug' --exclude 'test/' --exclude 'helper' \
  "$REPO_ROOT/cep/" "$PAYLOAD/"
rsync -a --exclude 'tests/' --exclude '__pycache__/' --exclude '*.pyc' \
  --exclude '.venv/' --exclude 'bin/' --exclude 'runtime/' \
  "$REPO_ROOT/helper/" "$PAYLOAD/helper/"

if [[ ! -d "$PAYLOAD/helper/vendor/pydeps" ]]; then
  "$REPO_ROOT/scripts/vendor-pydeps.sh"
  rsync -a "$REPO_ROOT/helper/vendor/pydeps/" "$PAYLOAD/helper/vendor/pydeps/"
fi

cp "$REPO_ROOT/LICENSE" "$PAYLOAD/LICENSE.txt"
cp "$REPO_ROOT/README.md" "$PAYLOAD/README.md"

# ---- bundled Python ------------------------------------------------------

# Both architectures: the upstream standalone builds are per-arch, not
# universal, and Illustrator still runs on Intel Macs. helper.js picks the
# matching one at runtime.
for arch_pair in "aarch64:arm64" "x86_64:x86_64"; do
  pbs_arch="${arch_pair%%:*}"
  our_arch="${arch_pair##*:}"
  tarball="cpython-$PYTHON_VERSION+$PBS_RELEASE-$pbs_arch-apple-darwin-install_only_stripped.tar.gz"
  cached="$TOOLS/$tarball"

  if [[ ! -f "$cached" ]]; then
    echo "==> Downloading Python $PYTHON_VERSION for $our_arch"
    mkdir -p "$TOOLS"
    curl -fsSL -o "$cached" "$PBS_BASE/$tarball" \
      || { echo "Could not download $tarball" >&2; exit 1; }
  fi

  echo "==> Unpacking the $our_arch runtime"
  target="$PAYLOAD/helper/runtime/macos-$our_arch"
  mkdir -p "$target"
  tar -xzf "$cached" -C "$target" --strip-components=1

  # Trim what a helper process will never touch. Keeps the installer to a size
  # people will actually download.
  rm -rf "$target/lib/python3."*/test \
         "$target/lib/python3."*/idlelib \
         "$target/lib/python3."*/tkinter \
         "$target/lib/python3."*/turtledemo \
         "$target/share" "$target/include"
  find "$target" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
done

echo "    payload: $(du -sh "$WORK/payload" | cut -f1)"

# ---- verify the payload actually works -----------------------------------

# Do this before signing: a broken payload that is correctly signed is still
# broken, and notarisation takes minutes to tell you nothing useful.
echo "==> Checking the bundled runtime drives the helper"
HOST_ARCH="$(uname -m)"; [[ "$HOST_ARCH" == "arm64" ]] || HOST_ARCH="x86_64"
BUNDLED_PY="$PAYLOAD/helper/runtime/macos-$HOST_ARCH/bin/python3"

if env -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH -u PYTHONPATH \
     PYTHONPATH="$PAYLOAD/helper" "$BUNDLED_PY" -m cameo_helper --selftest >/dev/null 2>&1; then
  echo "    OK — $("$BUNDLED_PY" --version) runs the helper with no system Python"
else
  echo "    FAILED: the bundled runtime could not run the helper." >&2
  env -u DYLD_LIBRARY_PATH -u PYTHONPATH PYTHONPATH="$PAYLOAD/helper" \
    "$BUNDLED_PY" -m cameo_helper --selftest 2>&1 | tail -20 >&2
  exit 1
fi

# ---- sign ----------------------------------------------------------------

if [[ $UNSIGNED -eq 1 ]]; then
  echo "==> Skipping signing (--unsigned)"
else
  echo "==> Signing every Mach-O in the payload"
  # Inside-out: nested code must be signed before whatever contains it.
  # Signing an already-signed upstream binary needs --force.
  find "$PAYLOAD" -type f \( -name "*.dylib" -o -name "*.so" -o -perm -u+x \) -print0 |
  while IFS= read -r -d '' file; do
    if file "$file" | grep -q "Mach-O"; then
      codesign --force --timestamp --options runtime \
        --entitlements "$REPO_ROOT/scripts/entitlements.plist" \
        --sign "$SIGN_APP" "$file" >/dev/null 2>&1 \
        || { echo "    failed to sign: $file" >&2; exit 1; }
    fi
  done
  echo "    signed $(find "$PAYLOAD" -type f -exec file {} \; | grep -c "Mach-O") binaries"
fi

# ---- build the package ---------------------------------------------------

echo "==> Building the package"
mkdir -p "$WORK/component"
COMPONENT="$WORK/component/cameo.pkg"

pkgbuild \
  --root "$WORK/payload" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --install-location "$INSTALL_LOCATION" \
  "$COMPONENT" >/dev/null

cat > "$WORK/distribution.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Cameo for Illustrator</title>
  <organization>com.samwinslet</organization>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <volume-check>
    <allowed-os-versions><os-version min="11.0"/></allowed-os-versions>
  </volume-check>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default" title="Cameo for Illustrator">
    <pkg-ref id="$PKG_ID"/>
  </choice>
  <pkg-ref id="$PKG_ID" version="$VERSION" onConclusion="none">cameo.pkg</pkg-ref>
</installer-gui-script>
EOF

rm -f "$OUTPUT"
if [[ $UNSIGNED -eq 1 ]]; then
  productbuild --distribution "$WORK/distribution.xml" \
    --package-path "$WORK/component" "$OUTPUT" >/dev/null
else
  productbuild --distribution "$WORK/distribution.xml" \
    --package-path "$WORK/component" --sign "$SIGN_PKG" \
    --timestamp "$OUTPUT" >/dev/null
fi

echo "    built: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"

# ---- notarise ------------------------------------------------------------

if [[ $UNSIGNED -eq 1 ]]; then
  cat <<'EOF'

Unsigned build complete. It will NOT install cleanly on another Mac —
Gatekeeper blocks unsigned packages. Use it to check the payload only.

To produce a distributable installer, set SIGN_APP, SIGN_PKG and
KEYCHAIN_PROFILE and re-run without --unsigned. See docs/packaging.md.
EOF
  exit 0
fi

echo "==> Notarising (this usually takes a few minutes)"
xcrun notarytool submit "$OUTPUT" --keychain-profile "$KEYCHAIN_PROFILE" --wait \
  || { echo "Notarisation failed. For the reason:" >&2
       echo "  xcrun notarytool log <submission-id> --keychain-profile $KEYCHAIN_PROFILE" >&2
       exit 1; }

echo "==> Stapling"
# Stapling attaches the ticket so the installer validates offline.
xcrun stapler staple "$OUTPUT"
xcrun stapler validate "$OUTPUT"

echo
echo "Built and notarised $OUTPUT"
echo "Verify on a clean Mac with: spctl --assess --type install -vv \"$OUTPUT\""
