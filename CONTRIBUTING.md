# Contributing

Thanks for considering it. This project drives real hardware that cuts real
material, so there's one thing worth saying up front:

> **A bug here wastes someone's vinyl, or damages their machine.** That's why the
> test suite is unusually strict about the byte stream, and why changes to the
> driver get more scrutiny than the amount of code would suggest.

## Getting set up

```bash
git clone https://github.com/winslet/cameo-illustrator.git
cd cameo-illustrator
./scripts/dev-install.sh
```

Then quit Illustrator completely and reopen it. The panel appears under
**Window → Extensions → Send to Silhouette**.

You need macOS, Illustrator 2020+, Python 3.9+ and Node 20+. You do **not** need
a Silhouette machine to work on most of this — see below.

## Running the tests

```bash
npm run test:all      # everything
npm test              # JavaScript only
npm run test:py       # Python only
```

Both suites must pass before a PR can be merged. CI runs them on macOS and
Linux, across Python 3.12/3.14 and Node 20/22, plus a Python 3.9 runtime check.

## Working without hardware

Most of the project can be developed and tested with no machine attached.

`SilhouetteCameo` supports `dry_run` (send nothing) and `force_hardware`
(pretend to be any model), and records everything it would have sent. So you can
generate the exact byte stream for any of the 19 supported machines:

```bash
PYTHONPATH=helper .venv/bin/python -m cameo_helper --selftest
```

In the panel, tick **Dry run**, or press **Preview** — which decodes the command
stream back into geometry, so you see what the machine would actually do rather
than a redraw of your artwork.

## Things to know before you change something

### `helper/vendor/silhouette/` is off-limits

Those files are copied byte-identical from
[inkscape-silhouette](https://github.com/fablabnbg/inkscape-silhouette), and
that is what keeps re-syncing upstream a `git diff` rather than a rewrite. They
carry years of per-model quirks that would be very hard to recover if lost.

Need a fix before upstream ships it? Add a runtime patch to
`helper/cameo_helper/patches.py`, documenting what breaks without it and how you
confirmed it against pristine upstream code. There's a worked example in there.

Please also report the bug upstream — everyone benefits.

### The wire-protocol snapshots are the safety net

`helper/tests/snapshots/` holds the exact bytes each of the 19 machines would
receive for a fixture design. Almost nobody has more than one or two of those
machines, so this is how a change that breaks a Portrait 2 gets noticed by
someone who only owns a Cameo 4.

If your change alters them, **read the diff carefully** — it changes what real
hardware receives — then:

```bash
cd helper && PYTHONPATH=. ../.venv/bin/python -m pytest tests/test_devices.py --snapshot-update
```

Explain in the PR why the change is correct. "The snapshots were failing" isn't
an explanation.

### ExtendScript is ES3

`cep/host/*.jsx` runs in Illustrator's ancient JavaScript engine. No `let`,
`const`, arrow functions, `JSON`, or `Array.prototype.forEach`. It's tested
under Node (`cep/test/host.test.js`) because the geometry maths is where the
real bugs live, so keep it loadable outside Illustrator — no top-level DOM
access.

### The panel's JavaScript must parse on Chromium 61

`cep/js/*.js` executes inside CEP, whose version is decided by the *host
application*, not by you. The manifest advertises Illustrator 2020 and newer, so
the floor is what Illustrator 2020 ships:

| Illustrator | CEP | Chromium | Node |
| --- | --- | --- | --- |
| 2020 (24.x) — **our floor** | 9 | **61** | **8.6** |
| 2021–2022 | 10–11 | 74–88 | 12–15 |
| 2026 (30.x) | 12 | 99 | 17.7 |

The risk is reaching for something too **new**. Write ES5-flavoured JavaScript
and you will be fine; the existing panel code already does.

This is sharper than an ordinary compatibility concern. **Optional chaining is a
parse error in Chromium 61** — one `?.` does not degrade a feature, it stops the
whole file loading and the panel never appears. And CI cannot catch it, because
every Node version in the matrix is far newer than the floor.

So there is a backstop:

```bash
node scripts/check-panel-syntax.js
```

It runs in CI and rejects constructs that postdate the floor — optional
chaining, nullish coalescing, logical assignment, `globalThis`,
`Object.fromEntries`, `flat`/`flatMap`, `replaceAll`, `structuredClone` and
friends. It is a heuristic, not a parser, so it backs up this guidance rather
than replacing it.

If you genuinely need newer syntax, raise the `Host` range in
`cep/CSXS/manifest.xml` first and update the table above — dropping support for
older Illustrator versions is a decision to make deliberately, not a side effect.

CI's Node floor is 18 because `node:test` did not exist before it. The suite
therefore cannot run on any CEP version at all, which is exactly why the syntax
check exists.

### Coordinates

Millimetres, y-down, origin at the artboard's top-left, all the way from
extraction to `plot()`. The device itself uses swapped axes and 1/20 mm units;
that conversion belongs in the driver, not in your code. If you find yourself
adding a unit conversion outside `simulator.py`, something has gone wrong.

## Pull requests

- Branch from `main`.
- Keep it focused. A PR that fixes a bug *and* reformats a file is hard to review.
- Say how you tested it, and **whether you tested on real hardware** — say so
  plainly if you didn't, that's normal and fine.
- If you did test on hardware, say which model. That's genuinely valuable
  information and it'll go in the commit history.
- Match the surrounding style. Comments explain *why*, not *what*.

## Reporting hardware results

If you run this against a real machine, please open an issue with the
**Device report** template — whether it worked or not. The project supports 19
machines that essentially nobody has all of, so a confirmed "Portrait 3 cuts
correctly" is a real contribution, and a confirmed failure is more valuable
still.

## Licence

GPL-2.0. By contributing you agree your work is licensed the same way.
