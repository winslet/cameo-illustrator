# Vendored code

The files in `silhouette/` are copied **unmodified** from
[fablabnbg/inkscape-silhouette](https://github.com/fablabnbg/inkscape-silhouette),
licensed **GPL-2.0**. See `LICENSE` at the repo root.

| Field | Value |
| --- | --- |
| Upstream | https://github.com/fablabnbg/inkscape-silhouette |
| Commit | `86b42f74e8ab955638a87b5e13bcda0433b9d628` (2026-07-31) |
| Files | `Graphtec.py`, `Strategy.py`, `Transport.py`, `Geometry.py`, `__init__.py` |

## Why these files, and only these

`Graphtec.py` is the driver: the `DEVICE` table (19 models), the GPGL command
dialect including the per-model quirks, and `plot()`. `Strategy.py` is the matless
cutting optimiser and pulls in `Geometry.py`. `Transport.py` is the USB/Bluetooth
byte-pipe that `Graphtec.py` imports.

Deliberately **not** vendored:

- `convert2dashes.py` — imports `inkex`, which only exists inside Inkscape.
- `beutil.py`, `StrategyMinTraveling.py` — nothing in the vendored set references them.
- `sendto_silhouette.py`, `silhouette_multi.py`, `MultiFrame.py`, `Dialog.py` —
  Inkscape extension entry points and wxPython UI. Our panel replaces these.

## Do not edit these files

Keeping them byte-identical to upstream is what makes re-syncing a `git diff` rather
than a rewrite. Upstream lands real device fixes regularly, and those fixes are the
entire reason we vendor instead of reimplementing.

Adaptations belong in `cameo_helper/` instead. `cameo_helper/driver.py` owns the
`sys.path` insertion that makes `from silhouette.Transport import ...` resolve
against this directory.

## Re-syncing

```bash
scripts/sync-vendor.sh          # diffs against upstream main and reports drift
```

After syncing, run `pytest helper/tests` — the per-model byte-stream snapshots will
show exactly which models changed behaviour.
