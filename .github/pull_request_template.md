## What this changes

<!-- One or two sentences. -->

## Why

<!-- The problem being solved. Link an issue if there is one. -->

## How it was tested

<!--
Be honest — "not tested on hardware" is the normal answer and is completely
fine. Saying so is much more useful than leaving it ambiguous.
-->

- [ ] `npm run test:all` passes
- [ ] Tested in Illustrator
- [ ] Tested on a real machine — model: <!-- e.g. Cameo 3 -->

## Checklist

- [ ] I did not modify `helper/vendor/silhouette/` (runtime fixes belong in
      `helper/cameo_helper/patches.py` — see CONTRIBUTING.md)
- [ ] If wire-protocol snapshots changed, I read the diff and explained below
      why the new bytes are correct

<!--
### Snapshot changes

Delete this section if none. Otherwise: which models changed, what changed in
the byte stream, and why that is right. Remember this alters what real hardware
receives.
-->
