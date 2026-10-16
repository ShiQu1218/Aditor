"""JSON Lines IPC 伺服器（stdin/stdout，每行一個 UTF-8 JSON）。供 Electron 主程序驅動。"""
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
from .profile import ProfileError, resolve_profiles


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
        raise BadRequest(f"缺少參數：{key}")
    return args[key]


def _jobs(v):
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, int) or v < 1:
        raise BadRequest("jobs 必須是正整數")
    return v


def _pick_profile(profiles, recorded):
    """derive 用快取文件記錄的語言（analysis.profile／profile），不是 profiles[0]。

    單一語言：直接用它（記錄的語言若不同則報錯，避免用錯語言的去重參數）。
    自動模式：必須帶 profile 參數，且必須是已知語言。"""
    if recorded is not None and not isinstance(recorded, str):
        raise BadRequest("profile 必須是語言字串")
    by_lang = {p.lang: p for p in profiles}
    if recorded:
        if recorded not in by_lang:
            raise BadRequest(f"快取記錄的語言 {recorded!r} 不在可用的語言設定檔中：{sorted(by_lang)}")
        return by_lang[recorded]
    if len(profiles) == 1:
        return profiles[0]
    raise BadRequest("自動語言模式的 derive 需要帶 profile（快取文件記錄的語言）")


class Server:
    def __init__(self, inp, out):
        self._in = inp
        self._out = out
        self._wlock = threading.Lock()
        self._state = threading.Lock()
        self._current: tuple[str, threading.Event] | None = None  # 執行中的 analyze
        self._threads: list[threading.Thread] = []

    # --- 輸出 ---
    def send(self, obj: dict) -> None:
        line = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        with self._wlock:
            self._out.write(line)
            self._out.flush()

    def _error(self, rid, exc: Exception, code: str | None = None) -> None:
        self.send({"id": rid, "type": "error", "code": code or _code(exc), "message": str(exc)})

    # --- 主迴圈 ---
    def serve(self) -> None:
        self.send({"type": "ready", "engine_version": ENGINE_VERSION})
        for raw in self._in:
            raw = raw.strip()
            if not raw:
                continue
            self._dispatch(raw)
        # stdin EOF：取消執行中的分析並等待工作緒收尾
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
                raise BadRequest(f"JSON 格式錯誤：{e}") from e
            if not isinstance(req, dict):
                raise BadRequest("請求必須是 JSON 物件")
            rid = req.get("id")
            cmd = req.get("cmd")
            args = req.get("args", {})
            if not isinstance(rid, str) or not isinstance(args, dict):
                raise BadRequest("id 必須是字串、args 必須是物件")
            if cmd == "cancel":
                self._cancel(rid, args)
                return
            handler = {"probe": self._probe, "analyze": self._analyze,
                       "derive": self._derive, "autoclip": self._autoclip}.get(cmd)
            if handler is None:
                raise BadRequest(f"未知指令：{cmd!r}")
            cancel = None
            if cmd == "analyze":
                with self._state:
                    if self._current is not None:
                        raise _Busy("已有分析進行中")
                    cancel = threading.Event()
                    self._current = (rid, cancel)
            th = threading.Thread(target=self._run, args=(rid, handler, args, cancel), daemon=True)
            self._threads.append(th)
            th.start()
        except _Busy as e:
            self._error(rid, e, "busy")
        except Exception as e:  # noqa: BLE001
            self._error(rid, e)

    def _run(self, rid, handler, args, cancel) -> None:
        # 先釋放 busy 狀態再送終結訊息，避免客戶端立刻重送時誤判 busy
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

    # --- 指令 ---
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
        profiles = resolve_profiles(Path(_arg(args, "profile_dir")))
        profile_arg = profiles[0] if len(profiles) == 1 else profiles
        cache_dir = Path(_arg(args, "cache_dir"))

        def progress(t: float, duration: float) -> None:
            self.send({"id": rid, "type": "progress", "t": t, "duration": duration})

        return analyze(path, profile_arg, cache_dir=cache_dir, beside=bool(args.get("beside", False)),
                       force=bool(args.get("force", False)), on_progress=progress, cancel=cancel,
                       hwaccel=bool(args.get("hwaccel", True)), jobs=_jobs(args.get("jobs")))

    def _derive(self, rid, args, cancel):
        try:
            events = [Event.from_dict(e) for e in _arg(args, "events")]
            spec = [SpecInterval.from_dict(s) for s in _arg(args, "spectating")]
        except (KeyError, TypeError) as e:
            raise BadRequest(f"參數格式錯誤：{e!r}") from e
        profiles = resolve_profiles(Path(_arg(args, "profile_dir")))
        return {"events": [e.to_dict() for e in derive(events, spec, _pick_profile(profiles, args.get("profile")))]}

    def _autoclip(self, rid, args, cancel):
        try:
            events = [Event.from_dict(e) for e in _arg(args, "events")]
            params = AutoClipParams.from_dict(_arg(args, "params"))
            duration = float(_arg(args, "duration"))
        except (KeyError, TypeError, ValueError) as e:
            raise BadRequest(f"參數格式錯誤：{e!r}") from e
        return {"clips": [c.to_dict() for c in auto_clips(events, params, duration)]}


def run() -> int:
    Server(sys.stdin.buffer, sys.stdout.buffer).serve()
    return 0
