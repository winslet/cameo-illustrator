# Packaging and release

Two artefacts, built by two scripts:

| Artefact | Script | Signing | Cost |
| --- | --- | --- | --- |
| `.zxp` extension | `scripts/build-zxp.sh` | Self-signed | Free |
| `.pkg` installer | `scripts/build-installer.sh` | Apple Developer ID + notarisation | $99/yr |

Both carry the same panel and helper. The `.pkg` additionally bundles a Python
runtime, which is the only reason it costs money — a bundled interpreter is a
compiled binary, and Gatekeeper blocks unsigned binaries.

## Why there is no compiled code in the `.zxp`

The helper's three dependencies — `pyusb`, `libusb1` and `libusb` — are all
`py3-none-any` wheels. Pure Python, so one vendored copy works on any Python 3,
and the `libusb` wheel carries prebuilt native libraries for macOS, Windows and
Linux.

`scripts/vendor-pydeps.sh` installs them into `helper/vendor/pydeps` and `lipo`s
the macOS libraries into one universal binary, placed inside the `usb1` package
directory — which is the first place `usb1` looks (see `usb1/_libusb1.py`).

That is what removes the `brew install libusb` step, and it means we ship no
compiled code of our own in the free tier, so there is nothing to notarise.

`helper/vendor/pydeps` is generated and gitignored, unlike
`helper/vendor/silhouette`, which is deliberately pinned in-tree.

## Building the `.zxp`

```bash
scripts/build-zxp.sh
```

Downloads Adobe's `ZXPSignCmd` on first run, creates a self-signed certificate
in `.tools/`, stages the panel and helper, checks the result, signs, and
verifies.

CEP will not load an unsigned extension unless the user sets `PlayerDebugMode`,
which no ordinary user will do — so even the free tier must be signed.

**The timestamp is not optional.** Without `-tsa`, the extension stops loading
the day the certificate expires. With it, the signature stays valid afterwards.
The script always passes one.

To use a real certificate instead:

```bash
CERT=/path/to/cert.p12 CERT_PASS=... scripts/build-zxp.sh
```

### The self-signed certificate

On first run the script generates `.tools/selfsigned.p12` using a **default
password written in the script itself**, so it is public. That is fine for local
builds. It is not fine for a key whose signature you are asking users to trust —
anyone with the file could sign a package that looks identical to yours.

Before publishing releases, create one properly:

```bash
rm .tools/selfsigned.p12
SELF_SIGN_PASS='<a strong password>' \
  CERT_COUNTRY=US CERT_ORG='Your Name' CERT_NAME='Your Name' \
  scripts/build-zxp.sh
```

`.tools/` is gitignored. **Never commit the `.p12`** — it is a private key.

**Back it up** (a password manager is ideal). Users see the publisher identity at
install; a new key means a new identity, and an installer may warn that the
extension differs from the one already installed.

### Wiring it into releases

Without these secrets the release workflow mints a *throwaway* certificate on
every run, so every release looks like a different publisher. Set them once:

```bash
base64 -i .tools/selfsigned.p12 | gh secret set ZXP_CERT_P12_BASE64
gh secret set ZXP_CERT_PASSWORD          # prompts, so it stays out of your shell history
```

Both are required together — the workflow fails with a clear error if only one
is set, rather than quietly falling back to a throwaway key.

## Building the `.pkg`

Check the payload without needing certificates:

```bash
scripts/build-installer.sh --unsigned
```

This downloads standalone CPython builds for both architectures, strips what the
helper never uses (`test`, `idlelib`, `tkinter`, `turtledemo`), assembles the
payload, and — importantly — **runs the helper with the bundled interpreter
before signing anything**. A correctly signed broken payload is still broken,
and notarisation takes minutes to tell you nothing useful.

For a real build:

```bash
export SIGN_APP="Developer ID Application: Your Name (TEAMID)"
export SIGN_PKG="Developer ID Installer: Your Name (TEAMID)"
export KEYCHAIN_PROFILE="cameo-notary"
scripts/build-installer.sh
```

### Getting the certificates

These are **not** the certificates an iOS membership hands you by default. An
Apple Developer Program membership entitles you to them, but you have to create
them, and only the account holder can:

1. In your Apple Developer account → Certificates → **+**
2. Create **Developer ID Application** (signs binaries) and **Developer ID
   Installer** (signs the `.pkg`). Two separate certificates.
3. Download both and double-click to add them to your keychain.
4. Confirm with `security find-identity -v -p codesigning`.

Then store notarisation credentials once:

```bash
xcrun notarytool store-credentials cameo-notary \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
```

The password is an **app-specific password** from appleid.apple.com, not your
Apple ID password.

### Entitlements

`scripts/entitlements.plist` grants two, both required by how the helper reaches
the cutter:

- `disable-library-validation` — the interpreter `dlopen`s libusb through
  ctypes; library validation would reject a library it didn't sign.
- `allow-unsigned-executable-memory` — ctypes builds foreign-function
  trampolines at runtime, which the hardened runtime blocks by default.

If notarisation rejects the build, read the actual reason rather than guessing:

```bash
xcrun notarytool log <submission-id> --keychain-profile cameo-notary
```

## Releasing

`.github/workflows/release.yml` does the work: it runs both suites, builds and
signs the `.zxp`, unpacks it and runs the helper out of the unpacked tree,
generates checksums, and creates the GitHub release with the artefacts attached.
**Do not build locally and upload by hand** — a release must come from a public
tagged commit to satisfy GPL-2.0, and the workflow is what guarantees that.

The signing certificate is stored once, as repository secrets, and reused by
every release. See *Wiring it into releases* above; you should not have to think
about it again.

### From the browser

Nothing here needs a clone.

1. **Actions → Prepare release → Run workflow**, and give it a version with no
   leading `v`. It opens a pull request setting the version in all four places
   and opening a `CHANGELOG.md` section.
2. Write the changelog entry into that pull request, and merge it.
3. **Releases → Draft a new release**, tag `vX.Y.Z` targeting `main`, and
   **Publish**.

Step 3 is deliberately left to you. A tag pushed with `GITHUB_TOKEN` does not
trigger other workflows — GitHub suppresses that so workflows cannot retrigger
each other — so a job that tagged on your behalf would publish a release with no
`.zxp` attached, which is the exact failure this is built to prevent. Publishing
from the Releases page is a human action, so it does trigger the build.

The prepare pull request itself gets no CI, for the same reason. It changes only
version strings, and nothing can ship without passing the checks below.

### From a clone

```bash
scripts/bump-version.sh 0.2.0        # all four places, plus a CHANGELOG section
```

Write the changelog entry, merge to `main`, then:

```bash
git tag v0.2.0 && git push origin v0.2.0
gh run watch --workflow=release.yml
```

### What is checked before anything is published

- Both suites pass. **Never release on a red suite** — the per-model snapshots
  are the only protection for the 18 machines nobody here owns.
- All four versions agree (`scripts/bump-version.sh --check`).
- The tag matches the manifest, with or without a leading `v`. `v0.2.0` and
  `0.2.0` both build `0.2.0`; anything else fails with an explicit error rather
  than publishing a mislabelled artefact.
- The helper runs out of the unpacked `.zxp` with no virtualenv, no Homebrew and
  no repository — the situation a user is actually in.

### Where the version lives

Four places, because four things read it. `scripts/bump-version.sh` sets them
together, and `--check` fails the release if they drift:

| File | Field |
| --- | --- |
| `cep/CSXS/manifest.xml` | `ExtensionBundleVersion` — what the build scripts read |
| `cep/CSXS/manifest.xml` | the `<Extension … Version>` attribute |
| `helper/pyproject.toml` | `version` |
| `package.json` | `version` |

The other `Version=` attributes in the manifest are CSXS and host versions, not
ours. Leave them alone.

### If a release has no `.zxp` attached

It carries only GitHub's automatic `Source code (zip)` and `(tar.gz)` — those
are generated for every release and are not the extension. That means the
workflow never ran, or ran and failed. Check with:

```bash
gh run list --workflow=release.yml
```

No runs at all means nothing triggered it. Delete the tag and the release, then
push a correctly named tag:

```bash
gh release delete <tag> --yes
git push origin :refs/tags/<tag>
```

## GPL-2.0 obligations

We vendor GPL-2.0 code, so the combined work is GPL-2.0 and **distributing a
binary obliges you to make the corresponding source available**.

Both build scripts copy `LICENSE` into the package. Publishing each
release from a public tagged commit satisfies the source requirement — so cut
releases from tags in the public repo, not from a local working tree.

This applies to a paid Adobe Exchange listing too. **GPL does not prevent you
charging for the software**, but you cannot stop a paying user redistributing
the source, and you must give them the source when you give them the binary. A
paid listing works as paying for convenience — the installer, and support —
which is a legitimate and common model, but go in knowing that is what you are
selling.

## Windows

Not implemented. The panel half of the `.zxp` is already cross-platform, and the
vendored `libusb` wheel carries Windows DLLs, but the transport does not yet
handle Windows — see the Limitations section of the README for why that needs
care rather than just a build target.
