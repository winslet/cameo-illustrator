# Development and architecture

How the plugin is put together, and how to work on it.

For installing and using the panel, see the [README](../README.md) and
[INSTALL.md](../INSTALL.md). For the contribution process, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

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

### Three deliberate choices

**The device protocol is vendored, not reimplemented.** `helper/vendor/silhouette/`
holds the driver from [fablabnbg/inkscape-silhouette][upstream], byte-identical to
upstream. It encodes years of reverse-engineered per-model quirks that would be
foolish to rewrite. Fixes we need before upstream ships them live in
`cameo_helper/patches.py` as documented runtime patches, so re-syncing stays a
`git diff`. See [`helper/vendor/VENDOR.md`](../helper/vendor/VENDOR.md).

**The helper talks over stdio, not HTTP.** No port to collide with, no auth token
to leak, no firewall prompt, and nothing listening on your machine.

**Nothing we ship is compiled.** The helper's dependencies are all pure-Python
wheels, and the `libusb` wheel carries prebuilt native libraries — so the `.zxp`
contains no binary of ours to sign or notarise, and users need no Homebrew step.
See [packaging.md](packaging.md).

## Getting set up

```bash
./scripts/dev-install.sh
```

Then **quit Illustrator completely and reopen it**, and find the panel under
**Window → Extensions → Send to Silhouette**.

The script enables CEP debug mode (required for unsigned extensions), symlinks
the panel so your edits appear on reload, creates the virtualenv, vendors the
Python dependencies, and runs a self-test.

You need macOS, Illustrator 2020+, Python 3.9+ and Node 18+. You do **not** need
a Silhouette machine to work on most of this.

## Running the tests

```bash
# Python: driver, jobs, per-model wire-protocol snapshots
cd helper && PYTHONPATH=. ../.venv/bin/python -m pytest tests/ -q

# JavaScript: bézier flattening, coordinate mapping, and the live RPC link
node --test cep/test/*.test.js

# Check what the driver sees without opening Illustrator
PYTHONPATH=helper .venv/bin/python -m cameo_helper --selftest
```

To debug the panel itself, open <http://localhost:8088> in Chrome while it is open.

## Wire-protocol snapshots

`helper/tests/snapshots/` holds the exact byte stream each of the 19 models would
receive for a fixture design, captured using the driver's `force_hardware` and
`dry_run` options. So a change in behaviour for a machine nobody here owns shows up
as a named test failure instead of as a ruined sheet of vinyl.

After an intentional change:

```bash
cd helper && PYTHONPATH=. ../.venv/bin/python -m pytest tests/test_devices.py --snapshot-update
```

Review that diff carefully — it changes what real hardware receives.

## Updating the vendored driver

```bash
./scripts/sync-vendor.sh          # show what changed upstream
./scripts/sync-vendor.sh --apply  # take it, then run the tests
```

## Building releases

```bash
./scripts/build-zxp.sh                    # signed .zxp
./scripts/build-installer.sh --unsigned   # .pkg payload, no certificates needed
```

Full release process, certificate setup and GPL obligations:
**[packaging.md](packaging.md)**.

[upstream]: https://github.com/fablabnbg/inkscape-silhouette
