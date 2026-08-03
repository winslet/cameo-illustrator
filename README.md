# Cameo for Illustrator

[![CI](https://github.com/winslet/cameo-illustrator/actions/workflows/ci.yml/badge.svg)](https://github.com/winslet/cameo-illustrator/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/winslet/cameo-illustrator?include_prereleases&sort=semver)](https://github.com/winslet/cameo-illustrator/releases)
[![Licence: GPL-2.0](https://img.shields.io/badge/licence-GPL--2.0-blue.svg)](LICENSE)
[![Machines supported](https://img.shields.io/badge/machines-19-brightgreen)](#)

Send artwork from Adobe Illustrator straight to a Silhouette cutting machine —
no Silhouette Studio round-trip, no export step.

Supports **19 machines**: Cameo 1–5 (including Plus, Pro, Alpha), Portrait 1–4,
Curio, Craft Robo, and Silhouette SD.

> **Status: pre-hardware.** The full pipeline works end to end in simulation and
> is covered by tests, but it has not yet been run against a physical cutter.
> Treat the first real cut as a calibration exercise — see
> [Verifying on hardware](#verifying-on-hardware).

## How it works

Illustrator has no public UXP API (as of 2026 Adobe still uses UXP internally for
Illustrator only), so the panel is a **CEP extension** — the same technology
Silhouette's own Connect plugin uses. CEP cannot reach USB, so a small local
helper process does that part.

```
Illustrator
├─ CEP panel (HTML/JS)        UI: material, tool settings, preview
├─ ExtendScript               walks the document → flattens béziers → mm polylines
│                             writes JSON to a temp file
└─ panel spawns the helper and pipes to it
     ↓ newline-delimited JSON over stdin/stdout
cameo-helper (Python)
├─ vendor/silhouette/         the inkscape-silhouette driver, vendored unmodified
└─ simulator                  decodes the wire protocol back into geometry
     ↓ USB (libusb)
   your cutter
```

Two deliberate choices are worth knowing about:

**The device protocol is vendored, not reimplemented.** `helper/vendor/silhouette/`
holds the driver from [fablabnbg/inkscape-silhouette][upstream], byte-identical to
upstream. It encodes years of reverse-engineered per-model quirks that would be
foolish to rewrite. Fixes we need before upstream ships them live in
`cameo_helper/patches.py` as documented runtime patches, so re-syncing stays a
`git diff`. See [`helper/vendor/VENDOR.md`](helper/vendor/VENDOR.md).

**The helper talks over stdio, not HTTP.** No port to collide with, no auth token
to leak, no firewall prompt, and nothing listening on your machine.

**Nothing we ship is compiled.** The helper's dependencies are all pure-Python
wheels, and the `libusb` wheel carries prebuilt native libraries — so the `.zxp`
contains no binary of ours to sign or notarise, and users need no Homebrew step.
See [docs/packaging.md](docs/packaging.md).

## Installing

Grab the `.pkg` installer or the `.zxp` extension from the
[latest release](https://github.com/winslet/cameo-illustrator/releases) —
see **[INSTALL.md](INSTALL.md)**. The installer needs nothing else; the `.zxp` is
much smaller but needs a Python 3.9+ on your Mac.

Requires macOS 11+ and Adobe Illustrator 2020 (24.0) or newer. No Homebrew, no
`pip`, no `libusb` install — everything else is bundled.

## Developing

```bash
./scripts/dev-install.sh
```

Then **quit Illustrator completely and reopen it**, and find the panel under
**Window → Extensions → Send to Silhouette**.

The script enables CEP debug mode (required for unsigned extensions), symlinks
the panel so your edits appear on reload, creates the virtualenv, vendors the
Python dependencies, and runs a self-test.

## Using it

1. Select the paths you want to cut. With nothing selected, the whole artboard is
   used.
2. Pick a material. The presets come from the driver's own table and set pressure,
   speed and blade depth on the machine; the swatch shows the recommended blade cap.
3. Press **Preview** to see exactly what the machine would cut, decoded back from
   the command stream it would receive. Preview never moves the machine.
4. Press **Send to Silhouette**.

**Bounding box only** traces the outline of your design — a cheap sanity check on
scrap before committing to an expensive sheet. **Cut without a mat** reorders cuts
so the material is not pulled apart by a cut upstream of where the blade still has
to travel.

### What gets cut

Paths, compound paths and groups cut directly. Text is outlined automatically (on
a temporary duplicate — **your artwork is never modified**). Hidden art, locked
art, and guides are skipped.

Placed images, symbols, blends and envelopes cannot be cut and are reported in the
panel rather than silently dropped. Expand them first (**Object → Expand**).

Clipping masks are ignored: everything inside a clipped group is cut, not just the
visible part.

## Verifying on hardware

The first cut on a real machine is the one thing simulation cannot stand in for.

1. Cut a **10 mm calibration square** on scrap and measure it. This is what catches
   unit and scaling errors.
2. Run **Bounding box only** on a real design with the blade removed or pressure at 1.
3. Then cut for real.

Placement is worth checking too. The driver offsets designs by each machine's
physical media margins, which differ per model — an original Cameo shifts 9 mm
across, the Cameo 5 family 6 mm the other way. The panel tells you when your model
does this.

## Development

```bash
# Python: driver, jobs, per-model wire-protocol snapshots
cd helper && PYTHONPATH=. ../.venv/bin/python -m pytest tests/ -q

# JavaScript: bézier flattening, coordinate mapping, and the live RPC link
node --test "cep/test/*.test.js"

# Check what the driver sees without opening Illustrator
PYTHONPATH=helper .venv/bin/python -m cameo_helper --selftest
```

To debug the panel itself, open <http://localhost:8088> in Chrome while it is open.

### Wire-protocol snapshots

`helper/tests/snapshots/` holds the exact byte stream each of the 19 models would
receive for a fixture design, captured using the driver's `force_hardware` and
`dry_run` options. So a change in behaviour for a machine nobody here owns shows up
as a named test failure instead of as a ruined sheet of vinyl.

After an intentional change:

```bash
cd helper && PYTHONPATH=. ../.venv/bin/python -m pytest tests/test_devices.py --snapshot-update
```

Review that diff carefully — it changes what real hardware receives.

### Updating the vendored driver

```bash
./scripts/sync-vendor.sh          # show what changed upstream
./scripts/sync-vendor.sh --apply  # take it, then run the tests
```

### Building releases

```bash
./scripts/build-zxp.sh                    # signed .zxp
./scripts/build-installer.sh --unsigned   # .pkg payload, no certificates needed
```

Full release process, certificate setup and GPL obligations:
**[docs/packaging.md](docs/packaging.md)**.

## Limitations

- **macOS only for now.** The transport layer is structured for Windows, but
  Windows needs care: the usual approach there replaces the driver with Zadig,
  which breaks Silhouette Studio until reverted. The better path is to talk
  through `usbprint.sys` directly, avoiding the swap — designed for, not built.
- **No Print & Cut.** Registration-mark sensing is supported by the underlying
  driver but not yet wired up in the panel.
- **No Bluetooth.** The driver supports it on Linux and Windows; macOS lacks the
  Python RFCOMM socket support it relies on.
- **Cancelling mid-cut** stops sending and sends the head home, but cannot undo
  what has already been cut.

## Contributing

Contributions are very welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

The single most useful thing you can contribute is a
[device report](https://github.com/winslet/cameo-illustrator/issues/new?template=device-report.yml),
whether it worked or not. This supports 19 machines that no one person owns, so
a confirmed "Portrait 3 cuts correctly" genuinely moves the project forward — and
a confirmed failure moves it further still.

## Licence

**GPL-2.0.** This project vendors GPL-2.0 code from
[fablabnbg/inkscape-silhouette][upstream], so the combined work is GPL-2.0. See
[`LICENSE`](LICENSE).

Enormous credit to the inkscape-silhouette maintainers — the hard part of this
problem is theirs, solved years ago.

[upstream]: https://github.com/fablabnbg/inkscape-silhouette
