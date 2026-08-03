"""Newline-delimited JSON over stdio.

The panel spawns this process and pipes to it. Deliberately not an HTTP server:
there is no port to collide, no auth token to get wrong, no firewall prompt, and
nothing listening on the user's machine.

Wire format — one JSON object per line, in both directions.

    ->  {"id": 1, "method": "cut", "params": {...}}
    <-  {"id": 1, "event": "progress", "done": 12, "total": 400}
    <-  {"id": 1, "ok": true, "result": {...}}
    <-  {"id": 1, "ok": false, "error": {"message": "...", "kind": "..."}}

Long jobs run on a worker thread so that ``cancel`` can be read and acted on
while a cut is in flight.
"""

from __future__ import annotations

import base64
import json
import sys
import threading
import traceback
from typing import Any, Callable, TextIO

from . import driver, jobs, simulator

PROTOCOL_VERSION = 1


class RpcError(Exception):
    """An error that is the caller's fault and should be reported, not logged."""

    def __init__(self, message: str, kind: str = "request"):
        super().__init__(message)
        self.kind = kind


class Server:
    def __init__(self, stdin: TextIO | None = None, stdout: TextIO | None = None):
        self._in = stdin if stdin is not None else sys.stdin
        self._out = stdout if stdout is not None else sys.stdout
        self._write_lock = threading.Lock()
        self._cancel = threading.Event()
        self._worker: threading.Thread | None = None
        self._running = True

        self._methods: dict[str, Callable[[dict[str, Any], int], Any]] = {
            "ping": self._ping,
            "list_devices": self._list_devices,
            "list_media": self._list_media,
            "get_status": self._get_status,
            "cut": self._cut,
            "cancel": self._cancel_job,
            "shutdown": self._shutdown,
        }

        #: Methods that must not block the read loop.
        self._async_methods = {"cut"}

    # -- transport ---------------------------------------------------------

    def _send(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, separators=(",", ":"))
        with self._write_lock:
            self._out.write(line + "\n")
            self._out.flush()

    def _send_result(self, req_id: int, result: Any) -> None:
        self._send({"id": req_id, "ok": True, "result": result})

    def _send_error(self, req_id: int, message: str, kind: str = "internal") -> None:
        self._send({"id": req_id, "ok": False, "error": {"message": message, "kind": kind}})

    def _send_event(self, req_id: int, event: str, **fields: Any) -> None:
        self._send({"id": req_id, "event": event, **fields})

    # -- main loop ---------------------------------------------------------

    def serve_forever(self) -> None:
        # Announce readiness so the panel does not have to poll.
        self._send({"event": "ready", "protocol": PROTOCOL_VERSION,
                    "driver_available": driver.available()})

        for line in self._in:
            line = line.strip()
            if not line:
                continue
            if not self._running:
                break
            self._handle_line(line)

    def _handle_line(self, line: str) -> None:
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            self._send_error(-1, f"Malformed JSON: {exc}", kind="protocol")
            return

        req_id = request.get("id", -1)
        method = request.get("method")
        params = request.get("params") or {}

        handler = self._methods.get(method)
        if handler is None:
            self._send_error(req_id, f"Unknown method: {method!r}", kind="protocol")
            return

        if method in self._async_methods:
            if self._worker is not None and self._worker.is_alive():
                self._send_error(req_id, "A job is already running.", kind="busy")
                return
            self._cancel.clear()
            self._worker = threading.Thread(
                target=self._run_guarded, args=(handler, params, req_id), daemon=True
            )
            self._worker.start()
        else:
            self._run_guarded(handler, params, req_id)

    def _run_guarded(
        self, handler: Callable[[dict[str, Any], int], Any], params: dict[str, Any], req_id: int
    ) -> None:
        try:
            self._send_result(req_id, handler(params, req_id))
        except RpcError as exc:
            self._send_error(req_id, str(exc), kind=exc.kind)
        except (ValueError, RuntimeError) as exc:
            self._send_error(req_id, str(exc), kind="request")
        except Exception as exc:  # unexpected: include a traceback on stderr
            traceback.print_exc(file=sys.stderr)
            self._send_error(req_id, f"{type(exc).__name__}: {exc}", kind="internal")

    # -- methods -----------------------------------------------------------

    def _ping(self, params: dict[str, Any], req_id: int) -> dict[str, Any]:
        return {
            "protocol": PROTOCOL_VERSION,
            "python": sys.version.split()[0],
            "driver_available": driver.available(),
            "driver_error": None if driver.available() else str(driver.IMPORT_ERROR),
        }

    def _list_devices(self, params: dict[str, Any], req_id: int) -> dict[str, Any]:
        driver.require()
        return {
            "attached": jobs.probe_device(params.get("force_hardware")),
            "catalog": driver.device_catalog(),
            "cutting_mats": driver.cutting_mats(),
        }

    def _list_media(self, params: dict[str, Any], req_id: int) -> dict[str, Any]:
        driver.require()
        return {"media": driver.media_catalog()}

    def _get_status(self, params: dict[str, Any], req_id: int) -> dict[str, Any]:
        driver.require()
        return jobs.probe_device(params.get("force_hardware"))

    def _cut(self, params: dict[str, Any], req_id: int) -> dict[str, Any]:
        cut_params = jobs.CutParams.from_dict(params)

        last_pct = -1

        def on_progress(done: int, total: int, flags: str) -> None:
            # Throttle to whole percentage points: a big design is tens of
            # thousands of strokes, and a line per stroke would swamp the pipe.
            nonlocal last_pct
            pct = int(done * 100 / total) if total else 0
            if pct != last_pct:
                last_pct = pct
                self._send_event(req_id, "progress", done=done, total=total,
                                 percent=pct, flags=flags)

        result = jobs.run_cut(cut_params, on_progress, self._cancel)

        response: dict[str, Any] = {
            "bbox": result.bbox,
            "device": result.device,
            "path_count": result.path_count,
            "point_count": result.point_count,
            "cancelled": result.cancelled,
        }

        # The transcript is only useful for dry runs and debugging, and can be
        # large, so it is opt-in.
        if params.get("return_transcript"):
            response["transcript"] = base64.b64encode(result.transcript).decode("ascii")
        if params.get("return_preview"):
            decoded = simulator.parse(result.transcript)
            response["preview_svg"] = simulator.to_svg(
                decoded, cut_params.media_width, cut_params.media_height
            )
            response["preview_paths"] = len(decoded.paths)

        return response

    def _cancel_job(self, params: dict[str, Any], req_id: int) -> dict[str, Any]:
        running = self._worker is not None and self._worker.is_alive()
        self._cancel.set()
        return {"cancelling": running}

    def _shutdown(self, params: dict[str, Any], req_id: int) -> dict[str, Any]:
        self._cancel.set()
        self._running = False
        return {"bye": True}
