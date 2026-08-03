# Security

## Reporting a vulnerability

Please report privately through
[GitHub Security Advisories](https://github.com/winslet/cameo-illustrator/security/advisories/new)
rather than opening a public issue. You can expect an initial response within a
week.

## What this software can do

Worth being concrete, since it's a plugin that talks to hardware:

- The panel spawns a **local helper process** and communicates over its stdin and
  stdout. It opens **no network socket and no port** — a deliberate choice over a
  localhost HTTP server, which would have been a listening service on your
  machine with an authentication problem attached.
- The helper talks to USB devices matching known Silhouette vendor and product
  IDs. It does not enumerate or touch anything else.
- Nothing is sent anywhere. There is no telemetry, no update check, and no
  network access of any kind at runtime.
- The panel reads the active Illustrator document and writes extracted geometry
  to a temporary file, which it deletes after reading.

## Distribution and signing

Release artefacts are built by the [release workflow](.github/workflows/release.yml)
from a tagged commit, and `SHA256SUMS.txt` is published alongside them — check it.

The `.zxp` is signed with a self-signed certificate, so installers report an
**unknown publisher**. That warning is expected and is about the certificate's
provenance, not the package's integrity: the signature still proves the package
has not been altered since it was built.

## Scope

The vendored driver in `helper/vendor/silhouette/` is third-party GPL-2.0 code
from [inkscape-silhouette](https://github.com/fablabnbg/inkscape-silhouette).
Issues in the protocol implementation itself are usually best reported upstream,
though please tell us too so it can be tracked here.
