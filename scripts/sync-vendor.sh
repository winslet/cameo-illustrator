#!/usr/bin/env bash
# Diff the vendored driver against upstream and report drift.
#   scripts/sync-vendor.sh          -> report differences only
#   scripts/sync-vendor.sh --apply  -> also copy upstream files in
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/helper/vendor/silhouette"
UPSTREAM="https://github.com/fablabnbg/inkscape-silhouette.git"
FILES=(Graphtec.py Strategy.py Transport.py Geometry.py __init__.py)

apply=0
[[ "${1:-}" == "--apply" ]] && apply=1

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Cloning upstream..."
git clone --depth 1 "$UPSTREAM" "$tmp/up" >/dev/null 2>&1
new_commit="$(git -C "$tmp/up" rev-parse HEAD)"
old_commit="$(cat "$REPO_ROOT/helper/vendor/UPSTREAM_COMMIT" 2>/dev/null || echo "none")"

echo "pinned:   $old_commit"
echo "upstream: $new_commit"
[[ "$old_commit" == "$new_commit" ]] && { echo "Already up to date."; exit 0; }

drift=0
for f in "${FILES[@]}"; do
  if ! diff -q "$VENDOR_DIR/$f" "$tmp/up/silhouette/$f" >/dev/null 2>&1; then
    drift=1
    echo
    echo "=== $f ==="
    diff -u "$VENDOR_DIR/$f" "$tmp/up/silhouette/$f" || true
  fi
done

if [[ $drift -eq 0 ]]; then
  echo "No changes to vendored files. Updating pin."
  echo "$new_commit" > "$REPO_ROOT/helper/vendor/UPSTREAM_COMMIT"
  exit 0
fi

if [[ $apply -eq 1 ]]; then
  for f in "${FILES[@]}"; do cp "$tmp/up/silhouette/$f" "$VENDOR_DIR/$f"; done
  echo "$new_commit" > "$REPO_ROOT/helper/vendor/UPSTREAM_COMMIT"
  echo
  echo "Applied. Update the commit in helper/vendor/VENDOR.md, then run:"
  echo "  pytest helper/tests"
  echo "Snapshot diffs will show exactly which models changed behaviour."
else
  echo
  echo "Re-run with --apply to take these changes."
fi
