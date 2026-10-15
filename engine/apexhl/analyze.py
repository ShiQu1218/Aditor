"""分析流程：probe → 快取判斷 → 校準 → 解碼／偵測／事件追蹤 → keyframes → 推導 → 存檔（spec §4.2、§5.5）。"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Callable

from . import ENGINE_VERSION
from .cache import (cache_path, load_cache, merge_clips, merge_reanalysis,
                    needs_reanalysis, save_cache)
from .calibrate import calibrate
from .decode import FrameStream
from .errors import Cancelled
from .derive import derive, sig_similar
from .detect import Detector
from .events import EventTracker
from .models import Clip, Event, SpecInterval
from .probe import keyframes, probe
from .profile import Profile

PARTIAL_EVERY = 30.0   # 每隔多少「影片秒」寫一次 partial
RESUME_BACK = 5.0      # 接續時回退秒數
PROGRESS_INTERVAL = 0.25  # on_progress 至多每 0.25 秒（實際時間）一次
DEDUPE_DT = 1.0


Cancelled = Cancelled  # 重新匯出：apexhl.analyze.Cancelled


def _noop(t: float, duration: float) -> None:
    pass


def _is_dup(e: Event, existing: list[Event], threshold: float) -> bool:
    for o in existing:
        if o.type != e.type or abs(o.t - e.t) > DEDUPE_DT:
            continue
        if (o.name_sig is None and e.name_sig is None) or sig_similar(o.name_sig, e.name_sig, threshold):
            return True
    return False


def _combine_events(old: list[Event], new: list[Event], threshold: float) -> list[Event]:
    # 只比對「既有 vs 新」；新事件之間不互相去重（同一次分析內的兩個真事件可能相隔 < 1 秒）
    out = list(old)
    for e in new:
        if not _is_dup(e, old, threshold):
            out.append(e)
    return sorted(out, key=lambda e: e.t)


def _merge_intervals(items: list[SpecInterval]) -> list[SpecInterval]:
    out: list[SpecInterval] = []
    for s in sorted(items, key=lambda i: i.start):
        if out and s.start <= out[-1].end:
            out[-1] = SpecInterval(out[-1].start, max(out[-1].end, s.end))
        else:
            out.append(SpecInterval(s.start, s.end))
    return out


def _make_doc(info, profile: Profile, status: str, progress_t: float, h_scale: float,
              events: list[Event], spectating: list[SpecInterval], clips: list[Clip]) -> dict:
    return {
        "version": 1,
        "video": info.to_dict(),
        "profile": profile.lang,
        "analysis": {"status": status, "progress_t": progress_t, "engine_version": ENGINE_VERSION,
                     "templates_version": profile.templates_version, "h_scale": h_scale},
        "events": [e.to_dict() for e in events],
        "spectating": [s.to_dict() for s in spectating],
        "clips": [c.to_dict() for c in clips],
    }


def _save(cp: Path, doc: dict, fallback: Path) -> Path:
    doc["cache_path"] = str(cp)
    written = save_cache(cp, doc, fallback_dir=fallback)
    if written != cp:
        doc["cache_path"] = str(written)
        save_cache(written, doc)
    return written


def _resumable(old: dict | None, info, profile: Profile) -> bool:
    if not old:
        return False
    a, v = old.get("analysis") or {}, old.get("video") or {}
    return (a.get("status") == "partial" and a.get("h_scale") is not None
            and v.get("size") == info.size
            and abs(float(v.get("mtime", -1.0)) - info.mtime) < 1e-6
            and a.get("engine_version") == ENGINE_VERSION
            and a.get("templates_version") == profile.templates_version)


def analyze(path: str, profile: Profile, *, cache_dir: Path, beside: bool = False,
            force: bool = False, on_progress: Callable[[float, float], None] = _noop,
            cancel: threading.Event | None = None, hwaccel: bool = True) -> dict:
    info = probe(path)
    cache_dir = Path(cache_dir)
    cp = cache_path(path, cache_dir, beside)
    old = load_cache(cp)
    if not force and old is not None and not needs_reanalysis(old, info, profile.templates_version):
        old["cache_path"] = str(cp)
        return old

    resuming = (not force) and _resumable(old, info, profile)
    old_clips = [Clip.from_dict(c) for c in (old or {}).get("clips", [])]
    thr = profile.name_sig_threshold
    if resuming:
        h_scale = float(old["analysis"].get("h_scale", 1.0))
        done_events = [Event.from_dict(e) for e in old.get("events", [])]
        done_spec = [SpecInterval.from_dict(s) for s in old.get("spectating", [])]
        base_raw = old.get("base_events")  # 重新分析前的舊事件（含使用者狀態），完成時合併
        start = max(0.0, float(old["analysis"].get("progress_t", 0.0)) - RESUME_BACK)
    else:
        h_scale = None  # 於 base_events 備妥後校準（可被取消）
        done_events, done_spec = [], []
        base_raw = None
        if old is not None:
            partial = (old.get("analysis") or {}).get("status") == "partial"
            base_raw = old.get("base_events") if partial else old.get("events")
        start = 0.0
    base_events = [Event.from_dict(e) for e in base_raw] if base_raw else []
    manual_clips = merge_clips(old_clips, [])
    if h_scale is None:
        try:
            h_scale = calibrate(path, info, profile, cancel=cancel)
        except Cancelled:
            doc = _make_doc(info, profile, "partial", 0.0, None, [], [], manual_clips)  # h_scale=None：尚未校準
            if base_events:
                doc["base_events"] = [e.to_dict() for e in base_events]
            _save(cp, doc, cache_dir)
            raise

    detector = Detector(profile, h_scale)
    tracker = EventTracker(profile, resume_start=start if resuming and start > 0 else None)

    def partial_doc(progress_t: float) -> dict:
        evs, spec = tracker.snapshot()
        doc = _make_doc(info, profile, "partial", progress_t, h_scale,
                        _combine_events(done_events, evs, thr),
                        _merge_intervals(done_spec + spec), manual_clips)
        if base_events:
            doc["base_events"] = [e.to_dict() for e in base_events]
        return doc

    stream = FrameStream(path, profile, start=start, hwaccel=hwaccel, codec=info.codec)
    last_save = start
    last_t = start
    last_emit = -1e9
    try:
        for t, banner, spec in stream:
            if cancel is not None and cancel.is_set():
                _save(cp, partial_doc(last_t), cache_dir)
                raise Cancelled()
            tracker.feed(t, detector.detect(banner, spec))
            last_t = t
            now = time.monotonic()
            if now - last_emit >= PROGRESS_INTERVAL:
                last_emit = now
                on_progress(t, info.duration)
            if t - last_save >= PARTIAL_EVERY:
                last_save = t
                _save(cp, partial_doc(t), cache_dir)
        if cancel is not None and cancel.is_set():
            _save(cp, partial_doc(last_t), cache_dir)
            raise Cancelled()
    finally:
        stream.close()
    on_progress(info.duration, info.duration)

    new_events, new_spec = tracker.finish()
    raw = _combine_events(done_events, new_events, thr)
    spectating = _merge_intervals(done_spec + new_spec)
    try:
        kf = keyframes(path)
    except Exception:
        kf = []
    unmatched: list[Event] = []
    if base_events:
        raw, unmatched = merge_reanalysis(base_events, raw)
    final = derive(raw, spectating, profile)
    doc = _make_doc(info, profile, "done", info.duration, h_scale, final, spectating, manual_clips)
    doc["keyframes"] = kf
    doc["unmatched"] = [e.to_dict() for e in unmatched]
    _save(cp, doc, cache_dir)
    return doc
