"""JSON Lines IPC server (one UTF-8 JSON value per stdin/stdout line), driven by the Electron main process."""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

from . import ENGINE_VERSION
from .analyze import Cancelled, analyze
from .autoclip import auto_clips
from .decode import DecodeError
from .derive import derive
from .models import AutoClipParams, Event, SpecInterval
from .probe import ProbeError, probe
from .layout import Layout, LayoutError, parse_aspect
from .profile import ProfileError, load_profile


class BadRequest(Exception):
    pass


class _Busy(Exception):
    pass


def _code(exc: Exception) -> str:
    if isinstance(exc, ProbeError):
        return "probe_failed"
    if isinstance(exc, DecodeError):
        return "decode_failed"
    if isinstance(exc, ProfileError):
        return "profile_error"
    if isinstance(exc, BadRequest):
        return "bad_request"
    if isinstance(exc, Cancelled):
        return "cancelled"
    return "internal"


def _arg(args: dict, key: str):
    if key not in args:
        raise BadRequest(f"Missing parameter: {key}")
    return args[key]


def _jobs(v):
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, int) or v < 1:
        raise BadRequest("jobs must be a positive integer")
    return v


def _layout(v) -> Layout | None:
    """Optional explicit game render aspect (`W:H` or `WxH`); missing uses video metadata."""
    if v is None:
        return None
    if not isinstance(v, str):
        raise BadRequest("aspect must be a string")
    try:
        return parse_aspect(v)
    except LayoutError as e:
        raise BadRequest(str(e)) from e


class Server:
    def __init__(self, inp, out):
        self._in = inp
        self._out = out
        self._wlock = threading.Lock()
        self._state = threading.Lock()
        self._current: tuple[str, threading.Event] | None = None  # Running analysis
        self._threads: list[threading.Thread] = []

    # --- Output ---
    def send(self, obj: dict) -> None:
        line = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        with self._wlock:
            self._out.write(line)
            self._out.flush()

    def _error(self, rid, exc: Exception, code: str | None = None) -> None:
        self.send({"id": rid, "type": "error", "code": code or _code(exc), "message": str(exc)})

    # --- Main loop ---
    def serve(self) -> None:
        self.send({"type": "ready", "engine_version": ENGINE_VERSION})
        for raw in self._in:
            raw = raw.strip()
            if not raw:
                continue
            self._dispatch(raw)
        # On stdin EOF, cancel the running analysis and wait for the worker thread to finish.
        with self._state:
            if self._current is not None:
                self._current[1].set()
        for t in self._threads:
            t.join()

    def _dispatch(self, raw) -> None:
        rid = None
        try:
            try:
                req = json.loads(raw)
            except ValueError as e:
                raise BadRequest(f"Invalid JSON: {e}") from e
            if not isinstance(req, dict):
                raise BadRequest("Request must be a JSON object")
            rid = req.get("id")
            cmd = req.get("cmd")
            args = req.get("args", {})
            if not isinstance(rid, str) or not isinstance(args, dict):
                raise BadRequest("id must be a string and args must be an object")
            if cmd == "cancel":
                self._cancel(rid, args)
                return
            handler = {"probe": self._probe, "analyze": self._analyze,
                       "derive": self._derive, "autoclip": self._autoclip}.get(cmd)
            if handler is None:
                raise BadRequest(f"Unknown command: {cmd!r}")
            cancel = None
            if cmd == "analyze":
                with self._state:
                    if self._current is not None:
                        raise _Busy("An analysis is already running")
                    cancel = threading.Event()
                    self._current = (rid, cancel)
            th = threading.Thread(target=self._run, args=(rid, handler, args, cancel), daemon=True)
            # Keep only active threads so long-running IPC sessions do not accumulate completed Thread objects.
            self._threads = [t for t in self._threads if t.is_alive()]
            self._threads.append(th)
            th.start()
        except _Busy as e:
            self._error(rid, e, "busy")
        except Exception as e:  # noqa: BLE001
            self._error(rid, e)

    def _run(self, rid, handler, args, cancel) -> None:
        # Clear the busy state before sending the terminal message to avoid reporting busy if the client immediately retries.
        try:
            data = handler(rid, args, cancel)
            self._release(cancel)
            self.send({"id": rid, "type": "result", "data": data})
        except Exception as e:  # noqa: BLE001
            self._release(cancel)
            self._error(rid, e)

    def _release(self, cancel) -> None:
        if cancel is not None:
            with self._state:
                if self._current is not None and self._current[1] is cancel:
                    self._current = None

    # --- Commands ---
    def _cancel(self, rid, args: dict) -> None:
        target = _arg(args, "target")
        with self._state:
            cur = self._current
            hit = cur is not None and cur[0] == target
            if hit:
                cur[1].set()
        self.send({"id": rid, "type": "result", "data": {"cancelled": hit}})

    def _probe(self, rid, args, cancel):
        return probe(_arg(args, "path")).to_dict()

    def _analyze(self, rid, args, cancel):
        path = _arg(args, "path")
        profile = load_profile(Path(_arg(args, "profile_dir")))
        layout = _layout(args.get("aspect"))
        cache_dir = Path(_arg(args, "cache_dir"))

        def progress(t: float, duration: float) -> None:
            self.send({"id": rid, "type": "progress", "t": t, "duration": duration})

        return analyze(path, profile, cache_dir=cache_dir, beside=bool(args.get("beside", False)),
                       force=bool(args.get("force", False)), on_progress=progress, cancel=cancel,
                       hwaccel=bool(args.get("hwaccel", True)), jobs=_jobs(args.get("jobs")), layout=layout)

    def _derive(self, rid, args, cancel):
        try:
            events = [Event.from_dict(e) for e in _arg(args, "events")]
            spec = [SpecInterval.from_dict(s) for s in _arg(args, "spectating")]
        except (KeyError, TypeError) as e:
            raise BadRequest(f"Invalid arguments: {e!r}") from e
        profile = load_profile(Path(_arg(args, "profile_dir")))
        return {"events": [e.to_dict() for e in derive(events, spec, profile)]}

    def _autoclip(self, rid, args, cancel):
        try:
            events = [Event.from_dict(e) for e in _arg(args, "events")]
            params = AutoClipParams.from_dict(_arg(args, "params"))
            duration = float(_arg(args, "duration"))
        except (KeyError, TypeError, ValueError) as e:
            raise BadRequest(f"Invalid arguments: {e!r}") from e
        return {"clips": [c.to_dict() for c in auto_clips(events, params, duration)]}


def run() -> int:
    Server(sys.stdin.buffer, sys.stdout.buffer).serve()
    return 0
