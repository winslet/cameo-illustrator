# Changelog

Notable changes to this project. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this project drives hardware, entries note explicitly when a change
alters **what bytes reach the machine**.

## [Unreleased]

## [0.1.0] — 2026-08-03

First release. Not yet tested against a physical cutter.

### Added

- Illustrator panel (CEP) that sends artwork to a Silhouette cutter without a
  Silhouette Studio round-trip.
- Support for 19 machines: Cameo 1–5 (incl. Plus, Pro, Alpha), Cameo Pro MK-II,
  Portrait 1–4, Craft Robo CC200/CC300, Silhouette SD 1–2.
- Geometry extraction from paths, compound paths and groups, with automatic text
  outlining on a temporary duplicate — the user's artwork is never modified.
  Adaptive bézier flattening to 0.05 mm, the device's own resolution.
- Material presets read from the driver's own table, so they cannot drift out of
  sync with the vendored driver.
- Cut preview decoded back from the command stream the machine would receive,
  rather than redrawn from the artwork.
- Matless cutting, multi-pass, bounding-box-only, X/Y offset, per-tool selection
  and dry run.
- Wire-protocol snapshot tests covering all 19 models, using the driver's
  `force_hardware` and `dry_run` support.
- Distributed as a `.zxp` extension.

### Fixed

- `MatFree` crashed on designs with disjoint shapes — `decide_left2right`
  compared `None` against a float when a barrier slice contained no segments.
  Confirmed against pristine upstream and patched at runtime in
  `helper/cameo_helper/patches.py`; reported upstream.
- **Artwork on hidden or locked layers was being cut.** Illustrator does not
  mark a layer's state on its children — a path on a hidden layer still reports
  `hidden === false` — so checking only each item's own flags let hidden artwork
  reach the machine. The ancestor chain is now walked. *Changes what reaches the
  machine: hidden and locked layers are now genuinely excluded.*
- **Cancel did nothing during a real cut, and the progress bar never moved.**
  `plot()` sends geometry in ≤1024-byte packets, but the driver only reported
  progress from a 4096-byte chunk loop that also skipped its first pass — so the
  callback never fired for plot data, and it is the only place cancellation is
  observed. Progress is now reported between packets.
- **Pen media overshot its strokes when cutting without a mat.** The driver
  infers pen mode from media 113, but only in `setup()`, which runs after the
  matless strategy has already reordered the paths — so `MatFree` applied its
  0.2 mm blade overshoot to pen work. *Changes what reaches the machine: pen
  strokes are no longer extended.*

### Known limitations

- **Never run against physical hardware.** Cut a 10 mm calibration square on
  scrap and measure it before committing real material.
- macOS only; the Windows transport is designed for but not implemented.
- No Print & Cut registration marks, and no Bluetooth.
- Clipping masks are ignored — everything inside a clipped group is cut.

[Unreleased]: https://github.com/winslet/cameo-illustrator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/winslet/cameo-illustrator/releases/tag/v0.1.0
