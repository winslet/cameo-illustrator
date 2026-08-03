#!/usr/bin/env bash
# Build a signed .zxp — the free distribution tier.
#
# The .zxp carries the panel AND the helper, including vendored Python packages
# and a prebuilt libusb, so the only thing a user needs on their machine is some
# Python 3. Nothing here is compiled by us, so nothing needs notarising.
#
#   scripts/build-zxp.sh                  # self-signed (free)
#   CERT=my.p12 CERT_PASS=… scripts/build-zxp.sh    # sign with a real certificate
#
# CEP will not load an unsigned extension unless the user sets PlayerDebugMode,
# which no ordinary user will do — so signing is required even for a free build.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$REPO_ROOT/.tools"
DIST="$REPO_ROOT/dist"
STAGE="$DIST/staging"
SIGNCMD="$TOOLS/ZXPSignCmd"
SIGNCMD_URL="https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/macOS/ZXPSignCmd"

# A timestamp is not optional in practice: without one the extension stops
# loading the day the signing certificate expires, which for a self-signed cert
# is a date you picked arbitrarily. With one, it keeps working.
TSA="${TSA:-http://timestamp.digicert.com}"

VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' \
  "$REPO_ROOT/cep/CSXS/manifest.xml" | head -1)"
[[ -n "$VERSION" ]] || { echo "Could not read version from the manifest." >&2; exit 1; }

OUTPUT="$DIST/cameo-illustrator-$VERSION.zxp"

# ---- tooling -------------------------------------------------------------

mkdir -p "$TOOLS" "$DIST"

if [[ ! -x "$SIGNCMD" ]]; then
  echo "==> Fetching Adobe's ZXPSignCmd"
  curl -sSL -o "$SIGNCMD" "$SIGNCMD_URL"
  chmod +x "$SIGNCMD"
  # It arrives quarantined; Gatekeeper would otherwise refuse to run it.
  xattr -d com.apple.quarantine "$SIGNCMD" 2>/dev/null || true
fi

# ---- certificate ---------------------------------------------------------

if [[ -n "${CERT:-}" ]]; then
  P12="$CERT"
  P12_PASS="${CERT_PASS:?CERT_PASS must be set when CERT is}"
  echo "==> Signing with the supplied certificate"
else
  P12="$TOOLS/selfsigned.p12"
  P12_PASS="${SELF_SIGN_PASS:-cameo-illustrator}"

  if [[ ! -f "$P12" ]]; then
    echo "==> Creating a self-signed certificate (10 years)"
    "$SIGNCMD" -selfSignedCert "${CERT_COUNTRY:-GB}" "" \
      "${CERT_ORG:-Cameo for Illustrator}" \
      "${CERT_NAME:-Cameo for Illustrator}" \
      "$P12_PASS" "$P12" -validityDays 3650 >/dev/null
  fi

  echo "==> Signing with the self-signed certificate"
  echo "    Users will see an 'unknown publisher' warning at install. That is"
  echo "    expected, and does not stop the extension loading."

  # The default password is written in this script, so it is public. Fine for a
  # local build; not fine for a key whose signature users are asked to trust.
  if [[ -z "${SELF_SIGN_PASS:-}" ]]; then
    echo
    echo "    NOTE: this key uses the default password from this script, which is"
    echo "    public. Fine for testing. Before publishing releases signed with it,"
    echo "    create one with a real password and your own details:"
    echo
    echo "      rm .tools/selfsigned.p12"
    echo "      SELF_SIGN_PASS='<a strong password>' CERT_COUNTRY=US \\"
    echo "        CERT_ORG='Your Name' CERT_NAME='Your Name' scripts/build-zxp.sh"
    echo
    echo "    Then back the .p12 up — losing it changes your publisher identity."
  fi
fi

# ---- stage ---------------------------------------------------------------

echo "==> Staging"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# The panel. Excludes the dev-only bits: the .debug descriptor, the mock
# harness and tests, and the helper symlink (the real helper is copied below).
rsync -a \
  --exclude '.debug' \
  --exclude 'test/' \
  --exclude 'helper' \
  "$REPO_ROOT/cep/" "$STAGE/"

# The helper, minus its test suite — the per-model snapshots alone are a lot of
# files that no end user needs.
rsync -a \
  --exclude 'tests/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.venv/' \
  --exclude 'bin/' \
  "$REPO_ROOT/helper/" "$STAGE/helper/"

if [[ ! -d "$STAGE/helper/vendor/pydeps" ]]; then
  echo "==> Vendored Python packages are missing; building them"
  "$REPO_ROOT/scripts/vendor-pydeps.sh"
  rsync -a "$REPO_ROOT/helper/vendor/pydeps/" "$STAGE/helper/vendor/pydeps/"
fi

# GPL-2.0: the binary distribution has to carry the licence, and we owe
# recipients the source. Shipping it in the package is the simplest way to
# satisfy that rather than relying on a written offer.
cp "$REPO_ROOT/LICENSE" "$STAGE/LICENSE.txt"
cp "$REPO_ROOT/README.md" "$STAGE/README.md"

echo "    staged: $(du -sh "$STAGE" | cut -f1)"

# ---- sanity checks -------------------------------------------------------

echo "==> Checking the staged package"
fail=0
for required in \
  "CSXS/manifest.xml" "index.html" "js/main.js" "js/helper.js" \
  "js/CSInterface.js" "host/index.jsx" "host/extract.jsx" "host/flatten.jsx" \
  "helper/cameo_helper/__main__.py" "helper/vendor/silhouette/Graphtec.py" \
  "helper/vendor/pydeps/usb1/__init__.py"
do
  [[ -e "$STAGE/$required" ]] || { echo "    MISSING: $required" >&2; fail=1; }
done

# The bundled native library is the whole point of vendoring; a build without it
# would fall back to a system libusb that most users will not have.
if [[ ! -f "$STAGE/helper/vendor/pydeps/usb1/libusb-1.0.dylib" ]]; then
  echo "    MISSING: bundled libusb-1.0.dylib" >&2
  fail=1
else
  echo "    libusb: $(lipo -archs "$STAGE/helper/vendor/pydeps/usb1/libusb-1.0.dylib")"
fi

# A stray .debug in a shipped package silently turns on remote debugging.
[[ -e "$STAGE/.debug" ]] && { echo "    .debug must not ship" >&2; fail=1; }

[[ $fail -eq 0 ]] || { echo "Staging checks failed." >&2; exit 1; }

# ---- sign ----------------------------------------------------------------

echo "==> Signing"
rm -f "$OUTPUT"
"$SIGNCMD" -sign "$STAGE" "$OUTPUT" "$P12" "$P12_PASS" -tsa "$TSA" \
  || { echo "Signing failed." >&2; exit 1; }

echo "==> Verifying"
"$SIGNCMD" -verify "$OUTPUT" -certInfo

echo
echo "Built $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "Install it with an unsigned-extension installer such as ZXP Installer,"
echo "or via Creative Cloud. See INSTALL.md."
