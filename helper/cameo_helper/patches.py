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


def _patch_progress_during_plot() -> str | None:
    """Report progress while plot data is being sent, so Cancel works.

    Without this, `progress_cb` is never called for the actual cut. `plot()`
    sends geometry through `safe_write()`, which splits it into packets of at
    most 1024 bytes; `write()` then reports progress from inside a loop that
    chunks at 4096 bytes *and* skips the report on its first pass::

        while o < len(data):
            if o:                     # false on the first iteration
                self.progress_cb(...)
            chunk = data[o:o + 4096]

    A packet of 1024 bytes is one iteration with ``o == 0``, so the callback
    never fires. Two consequences: the progress bar sits still for the whole
    cut, and — since the callback is where cancellation is observed — pressing
    Cancel does nothing until the entire job has finished.

    This wraps `safe_write` to report between packets. `safe_write` already
    waits for the device to be ready between them, so they are natural points
    to stop at, and 1KB granularity is far finer than a progress bar needs.

    Verified against pristine upstream (commit 86b42f7); drop this if upstream
    starts reporting progress from `safe_write`.
    """
    from silhouette.Graphtec import SilhouetteCameo  # type: ignore[import-not-found]

    original = SilhouetteCameo.safe_write

    if getattr(original, "_cameo_patched", False):
        return None

    def safe_write(self, data):
        callback = getattr(self, "progress_cb", None)
        if callback is None:
            return original(self, data)

        total = len(data) if data else 0
        sent = [0]
        bound_write = self.write

        def counting_write(data=None, **kwargs):
            # safe_write polls the device between packets via wait_for_ready,
            # and those status queries come through write() too. Counting them
            # would push `done` past `total` and make the bar jump.
            if kwargs.get("is_query"):
                return bound_write(data=data, **kwargs)

            # Reported before the packet, so a cancel is seen without sending it.
            callback(sent[0], total, "")
            result = bound_write(data=data, **kwargs)
            sent[0] += len(data) if data else 0
            return result

        # Shadow the bound method for the duration of this call only.
        self.write = counting_write
        try:
            result = original(self, data)
        finally:
            del self.write  # restores the class method
        callback(total, total, "")
        return result

    safe_write._cameo_patched = True  # type: ignore[attr-defined]
    SilhouetteCameo.safe_write = safe_write
    return "SilhouetteCameo.safe_write: report progress between packets"


def apply_all() -> list[str]:
    """Apply every patch. Returns a description of each one applied."""
    global _applied
    if _applied:
        return []

    applied = []
    for patch in (_patch_matfree_empty_slice, _patch_progress_during_plot):
        description = patch()
        if description:
            applied.append(description)

    _applied = True
    return applied
