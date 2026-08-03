"""Runtime fixes for confirmed upstream bugs.

The vendored driver is kept byte-identical to upstream so that re-syncing stays a
`git diff` (see `helper/vendor/VENDOR.md`). Bugs we need fixed before upstream
does are therefore patched here, at runtime, rather than edited into the vendored
files.

Every patch must state what breaks without it, how it was confirmed against
pristine upstream code, and what makes it safe to drop later. Patches are
idempotent and applied once from `driver.py`.
"""

from __future__ import annotations

_applied = False


def _patch_matfree_empty_slice() -> str | None:
    """Stop `MatFree` crashing when a barrier slice contains no segments.

    Without this, matless cutting raises
    `TypeError: '>=' not supported between instances of 'NoneType' and 'float'`
    from `Strategy.decide_left2right`.

    `process_simple_barrier` leaves `min_x`/`max_x` as `None` when a slice
    collects no segments, then passes them straight to `decide_left2right`, which
    compares them against a float. Reproduced on pristine upstream
    (commit 86b42f7) with two disjoint shapes:

        MatFree('default', scale=1.0, pen=False).apply([
            [(10,10),(30,10),(30,30),(10,30),(10,10)],
            [(50,50),(70,50),(60,70),(50,50)],
        ])

    The direction returned is irrelevant in this case — with no segments the
    caller's loop is a no-op — so returning `True` is safe.

    Drop this once upstream guards the `None` case.
    """
    from silhouette.Strategy import MatFree  # type: ignore[import-not-found]

    original = MatFree.decide_left2right

    if getattr(original, "_cameo_patched", False):
        return None

    def decide_left2right(s, min_x, max_x, last_x=0.0):
        if min_x is None or max_x is None:
            return True
        return original(s, min_x, max_x, last_x)

    decide_left2right._cameo_patched = True  # type: ignore[attr-defined]
    MatFree.decide_left2right = decide_left2right
    return "MatFree.decide_left2right: guard empty barrier slices"


def apply_all() -> list[str]:
    """Apply every patch. Returns a description of each one applied."""
    global _applied
    if _applied:
        return []

    applied = []
    for patch in (_patch_matfree_empty_slice,):
        description = patch()
        if description:
            applied.append(description)

    _applied = True
    return applied
