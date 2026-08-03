"""Entry point for the helper process.

Spawned by the CEP panel and talked to over stdin/stdout. Also runnable by hand,
which is the quickest way to check the driver is working:

    python -m cameo_helper --selftest
"""

from __future__ import annotations

import argparse
import json
import sys

from . import driver, jobs, rpc, simulator


def _selftest() -> int:
    """Dry-run a small square and report what the driver produced."""
    print(f"driver available: {driver.available()}")
    if not driver.available():
        print(f"  reason: {driver.IMPORT_ERROR}", file=sys.stderr)
        return 1

    print(f"models known:     {len(driver.device_catalog())}")
    print(f"media presets:    {len(driver.media_catalog())}")

    attached = jobs.probe_device()
    print(f"attached device:  {attached['label']} (connected={attached['connected']})")

    square = [[(10.0, 10.0), (30.0, 10.0), (30.0, 30.0), (10.0, 30.0), (10.0, 10.0)]]
    result = jobs.run_cut(jobs.CutParams(paths=square, dry_run=True))
    decoded = simulator.parse(result.transcript)

    print(f"transcript:       {len(result.transcript)} bytes")
    print(f"decoded paths:    {len(decoded.paths)}")
    print(f"decoded bbox mm:  {decoded.bbox()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cameo_helper")
    parser.add_argument("--selftest", action="store_true",
                        help="dry-run a test square and exit")
    parser.add_argument("--info", action="store_true",
                        help="print device and media catalogs as JSON and exit")
    args = parser.parse_args(argv)

    if args.selftest:
        return _selftest()

    if args.info:
        driver.require()
        json.dump(
            {
                "devices": driver.device_catalog(),
                "media": driver.media_catalog(),
                "cutting_mats": driver.cutting_mats(),
            },
            sys.stdout,
            indent=2,
        )
        sys.stdout.write("\n")
        return 0

    rpc.Server().serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
