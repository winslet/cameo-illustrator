# Changelog

Notable changes to this project. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this project drives hardware, entries note explicitly when a change
alters **what bytes reach the machine**.

## [Unreleased]

## [0.1.0] — unreleased

First release. Not yet tested against a physical cutter.

### Added

- Illustrator panel (CEP) that sends artwork to a Silhouette cutter without a
  Silhouette Studio round-trip.
- Support for 19 machines: Cameo 1–5 (incl. Plus, Pro, Alpha), Portrait 1–4,
  Curio, Craft Robo CC200/CC300, Silhouette SD 1–2.
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
- Two distribution formats: a `.zxp` extension, and a `.pkg` installer that
  bundles its own Python runtime.

### Fixed

- `MatFree` crashed on designs with disjoint shapes — `decide_left2right`
  compared `None` against a float when a barrier slice contained no segments.
  Confirmed against pristine upstream and patched at runtime in
  `helper/cameo_helper/patches.py`; reported upstream.

### Known limitations

- **Never run against physical hardware.** Cut a 10 mm calibration square on
  scrap and measure it before committing real material.
- macOS only; the Windows transport is designed for but not implemented.
- No Print & Cut registration marks, and no Bluetooth.
- Clipping masks are ignored — everything inside a clipped group is cut.

[Unreleased]: https://github.com/winslet/cameo-illustrator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/winslet/cameo-illustrator/releases/tag/v0.1.0
