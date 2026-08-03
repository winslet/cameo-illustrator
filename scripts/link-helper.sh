#!/usr/bin/env bash
# Link helper/ into cep/helper.
#
# The panel looks for the helper at <extension>/helper, which is where a
# packaged build puts it. In a checkout the two live side by side, so a symlink
# makes the same lookup work — for development, and for the test suite, which
# spawns the real helper through the real resolver.
#
# Kept as its own script because both dev-install.sh and CI need it, and a
# silently drifting copy of this in a workflow file would be a confusing failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ln -sfn "$REPO_ROOT/helper" "$REPO_ROOT/cep/helper"
echo "cep/helper -> $(readlink "$REPO_ROOT/cep/helper")"
