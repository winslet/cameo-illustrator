#!/usr/bin/env bash
# Set the release version everywhere it is written down, or check the copies
# agree.
#
#   scripts/bump-version.sh 0.2.0     # rewrite all four, and open a CHANGELOG section
#   scripts/bump-version.sh --check   # verify they agree; exit 1 if they drift
#
# The version lives in four places because four different things read it: CEP
# reads the manifest, pip reads pyproject, npm reads package.json, and the
# manifest says it twice — once for the bundle and once for the extension inside
# it. Nothing keeps them in step, and the release workflow only compares the tag
# against the bundle version, so the other three can drift without anything
# noticing until a user has the package.
#
# --check is that missing guard, and runs in the release workflow.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO_ROOT/cep/CSXS/manifest.xml"
PYPROJECT="$REPO_ROOT/helper/pyproject.toml"
PACKAGE_JSON="$REPO_ROOT/package.json"
CHANGELOG="$REPO_ROOT/CHANGELOG.md"

# Read each copy from the file that owns it, rather than trusting one to speak
# for the rest — the whole point is to catch them disagreeing.
read_bundle_version() {
  sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$MANIFEST" | head -1
}

read_extension_version() {
  sed -n '/<Extension Id=/ s/.*Version="\([^"]*\)".*/\1/p' "$MANIFEST" | head -1
}

read_pyproject_version() {
  sed -n 's/^version = "\([^"]*\)".*/\1/p' "$PYPROJECT" | head -1
}

read_package_version() {
  sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$PACKAGE_JSON" | head -1
}

check_consistent() {
  local bundle extension pyproject package failed=0
  bundle="$(read_bundle_version)"
  extension="$(read_extension_version)"
  pyproject="$(read_pyproject_version)"
  package="$(read_package_version)"

  echo "  cep/CSXS/manifest.xml  ExtensionBundleVersion  ${bundle:-<not found>}"
  echo "  cep/CSXS/manifest.xml  Extension Version       ${extension:-<not found>}"
  echo "  helper/pyproject.toml  version                 ${pyproject:-<not found>}"
  echo "  package.json           version                 ${package:-<not found>}"

  for value in "$bundle" "$extension" "$pyproject" "$package"; do
    if [[ -z "$value" ]]; then
      echo "A version could not be read — the file layout changed." >&2
      failed=1
    elif [[ "$value" != "$bundle" ]]; then
      failed=1
    fi
  done

  if [[ $failed -eq 1 ]]; then
    echo >&2
    echo "Versions disagree. Set them all with: scripts/bump-version.sh <version>" >&2
    return 1
  fi

  echo
  echo "All four agree on $bundle"
}

# ---- check mode ----------------------------------------------------------

if [[ "${1:-}" == "--check" ]]; then
  echo "==> Checking the version is consistent"
  check_consistent
  exit 0
fi

# ---- bump mode -----------------------------------------------------------

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: scripts/bump-version.sh <version>    e.g. 0.2.0" >&2
  echo "       scripts/bump-version.sh --check" >&2
  exit 1
fi

# No leading 'v' here. The tag carries one by convention, the version does not,
# and a 'v' that reaches the manifest would fail the release workflow's tag
# check in a way that reads as a mismatch rather than a typo.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Not a version: '$VERSION'. Expected 0.2.0, or 0.2.0-beta1 — with no leading 'v'." >&2
  exit 1
fi

PREVIOUS="$(read_bundle_version)"
if [[ "$VERSION" == "$PREVIOUS" ]]; then
  echo "Already at $VERSION — nothing to do."
  exit 0
fi

echo "==> $PREVIOUS -> $VERSION"

# Every edit below writes to a temporary file and moves it into place. In-place
# sed is spelled differently on BSD and GNU, and this runs on both a Mac and an
# Ubuntu runner.
replace_in_place() {
  local file="$1" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  # Copy back over the original rather than moving the temporary file onto it,
  # which would replace the file's permissions with mktemp's 0600.
  #
  # An empty result means the filter upstream broke; writing it would silently
  # blank a file the release reads.
  if [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    echo "Refusing to write an empty $file" >&2
    return 1
  fi
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

# Both versions in the manifest. The second expression is anchored to the
# '<Extension Id=' line so it cannot touch ExtensionManifest's own Version
# attribute, nor the CSXS and host versions further down — those are API
# versions and have nothing to do with ours.
sed -e "s/\(ExtensionBundleVersion=\"\)[^\"]*\"/\1$VERSION\"/" \
    -e "/<Extension Id=/ s/Version=\"[^\"]*\"/Version=\"$VERSION\"/" \
    "$MANIFEST" | replace_in_place "$MANIFEST"

# First match only, in both files below: 'version' recurs in dependency pins and
# in npm scripts, and only the project's own key should move.
awk -v v="$VERSION" '
  !done && /^version = "/ { sub(/"[^"]*"/, "\"" v "\""); done = 1 }
  { print }
' "$PYPROJECT" | replace_in_place "$PYPROJECT"

awk -v v="$VERSION" '
  !done && /^  "version": "/ { sub(/: "[^"]*"/, ": \"" v "\""); done = 1 }
  { print }
' "$PACKAGE_JSON" | replace_in_place "$PACKAGE_JSON"

# ---- changelog -----------------------------------------------------------

# Open a dated section and leave Unreleased empty above it, then repoint the
# link references. What the section *says* is still yours to write — this only
# does the mechanical part that is easy to forget and invisible when wrong.
TODAY="$(date +%Y-%m-%d)"

if grep -q "^## \[$VERSION\]" "$CHANGELOG"; then
  echo "    CHANGELOG.md already has a $VERSION section, leaving it alone"
else
  awk -v v="$VERSION" -v today="$TODAY" -v prev="$PREVIOUS" '
    /^## \[Unreleased\]/ && !opened {
      print
      print ""
      print "## [" v "] — " today
      opened = 1
      next
    }
    /^\[Unreleased\]: / && !relinked {
      base = substr($0, index($0, ": ") + 2)
      sub(/\/compare\/.*$/, "", base)
      print "[Unreleased]: " base "/compare/v" v "...HEAD"
      print "[" v "]: " base "/compare/v" prev "...v" v
      relinked = 1
      next
    }
    { print }
  ' "$CHANGELOG" | replace_in_place "$CHANGELOG"
  echo "    CHANGELOG.md: opened [$VERSION] — $TODAY"
fi

# ---- confirm -------------------------------------------------------------

echo
check_consistent
echo
echo "Now write the CHANGELOG entry, then commit, merge to main, and release."
echo "See docs/packaging.md."
