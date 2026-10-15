"""分析流程：probe → 快取判斷 → 校準 → 解碼／偵測／事件追蹤 → keyframes → 推導 → 存檔（spec §4.2、§5.5）。"""
from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import ENGINE_VERSION
from .cache import (cache_path, load_cache, merge_clips, merge_reanalysis,
                    needs_reanalysis, save_cache)
from .calibrate import calibrate
from .decode import FrameStream, is_gpu_path
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
SEGMENT_OVERLAP = 5.0  # 切段解碼時與下一段重疊的秒數
AUTO_MIN_SEGMENT = 30.0  # 自動 jobs 時每段至少多長（秒）
EXPLICIT_MIN_SEGMENT = 5.0  # 明確指定 jobs 時每段至少多長（秒）
GRID = 0.25


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


def plan_segments(duration: float, jobs: int, *, min_len: float = AUTO_MIN_SEGMENT) -> list[tuple[float, float]]:
    """把 [0, duration] 平均切成最多 jobs 段（每段至少 min_len 秒），邊界對齊 0.25 秒格線。

    回傳 [(start, end)]；解碼範圍為 [start, end + SEGMENT_OVERLAP]（最後一段到片尾）。
    """
    n = max(1, min(int(jobs), int(duration // min_len) if min_len > 0 else int(jobs)))
    bounds = [0.0]
    for i in range(1, n):
        bounds.append(round(duration * i / n / GRID) * GRID)
    bounds.append(duration)
    return [(bounds[i], bounds[i + 1]) for i in range(n)]


def auto_jobs(gpu_path: bool) -> int:
    """自動 jobs：硬體路徑 min(4, max(1, cpu // 4))；軟體路徑（dav1d 已多執行緒）為 1。"""
    if not gpu_path:
        return 1
    return min(4, max(1, (os.cpu_count() or 4) // 4))


@dataclass
class _Seg:
    start: float
    end: float          # 名目結尾（不含重疊）
    last: bool
    duration: float
    progress_t: float = 0.0   # 即時進度（工作緒更新）
    snap_progress: float = 0.0  # 與 snap_events/snap_spec 對應的進度（寫入 partial 用）
    snap_events: list = field(default_factory=list)
    snap_spec: list = field(default_factory=list)

    @property
    def dec_end(self) -> float | None:
        return None if self.last else min(self.end + SEGMENT_OVERLAP, self.duration)

    @property
    def target(self) -> float:
        return self.end if self.last else self.dec_end

    @property
    def done(self) -> bool:
        return self.progress_t >= self.target - 1e-6

    def contribution(self, progress: float) -> float:
        return min(max(progress - self.start, 0.0), self.end - self.start)

    def to_dict(self) -> dict:
        return {"start": self.start, "end": self.end, "progress_t": self.snap_progress}


def _segments_from_doc(raw, duration: float) -> list[_Seg] | None:
    """驗證並還原 partial 內的 segments；格式不符回傳 None。"""
    try:
        segs = [_Seg(float(d["start"]), float(d["end"]), False, duration,
                     float(d["progress_t"]), float(d["progress_t"])) for d in raw]
    except (KeyError, TypeError, ValueError):
        return None
    if not segs or segs[0].start != 0.0 or abs(segs[-1].end - duration) > 1e-6:
        return None
    if any(abs(a.end - b.start) > 1e-6 for a, b in zip(segs, segs[1:])):
        return None
    segs[-1].last = True
    return segs


def _make_doc(info, profile: Profile, status: str, progress_t: float, h_scale: float,
              events: list[Event], spectating: list[SpecInterval], clips: list[Clip],
              segments: list[dict] | None = None) -> dict:
    doc = {
        "version": 1,
        "video": info.to_dict(),
        "profile": profile.lang,
        "analysis": {"status": status, "progress_t": progress_t, "engine_version": ENGINE_VERSION,
                     "templates_version": profile.templates_version, "h_scale": h_scale},
        "events": [e.to_dict() for e in events],
        "spectating": [s.to_dict() for s in spectating],
        "clips": [c.to_dict() for c in clips],
    }
    if segments:
        doc["analysis"]["segments"] = segments
    return doc


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
            cancel: threading.Event | None = None, hwaccel: bool = True,
            jobs: int | None = None) -> dict:
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
    segs: list[_Seg] | None = None
    if resuming:
        raw_segs = old["analysis"].get("segments")
        if raw_segs:
            segs = _segments_from_doc(raw_segs, info.duration)
            resuming = segs is not None  # 格式不符就當作沒有可接續的 partial
    if resuming:
        h_scale = float(old["analysis"].get("h_scale", 1.0))
        done_events = [Event.from_dict(e) for e in old.get("events", [])]
        done_spec = [SpecInterval.from_dict(s) for s in old.get("spectating", [])]
        base_raw = old.get("base_events")  # 重新分析前的舊事件（含使用者狀態），完成時合併
        if segs is None:  # 沒有 segments 的舊 partial：視為單一段，從 progress_t 接續
            p = float(old["analysis"].get("progress_t", 0.0))
            segs = [_Seg(0.0, info.duration, True, info.duration, p, p)]
    else:
        h_scale = None  # 於 base_events 備妥後校準（可被取消）
        done_events, done_spec = [], []
        base_raw = None
        if old is not None:
            partial = (old.get("analysis") or {}).get("status") == "partial"
            base_raw = old.get("base_events") if partial else old.get("events")
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
        if jobs is None:
            n_jobs, min_len = auto_jobs(is_gpu_path(info.codec, hwaccel)), AUTO_MIN_SEGMENT
        else:
            n_jobs, min_len = max(1, int(jobs)), EXPLICIT_MIN_SEGMENT
        plan = plan_segments(info.duration, n_jobs, min_len=min_len)
        segs = [_Seg(a, b, i == len(plan) - 1, info.duration, a, a) for i, (a, b) in enumerate(plan)]

    lock = threading.Lock()
    abort = threading.Event()  # 某段失敗時通知其他段停止
    state = {"last_emit": -1e9}

    def stopped() -> bool:
        return abort.is_set() or (cancel is not None and cancel.is_set())

    def combined():
        # 依段起點順序逐段合併：只做「不同段之間」（含既有事件）的去重，不做同段內去重
        evs = list(done_events)
        spec = list(done_spec)
        for sg in segs:
            evs = _combine_events(evs, sg.snap_events, thr)
            spec += sg.snap_spec
        return evs, _merge_intervals(spec)

    def partial_doc() -> dict:
        evs, spec = combined()
        doc = _make_doc(info, profile, "partial", sum(sg.contribution(sg.snap_progress) for sg in segs),
                        h_scale, evs, spec, manual_clips,
                        [sg.to_dict() for sg in segs] if len(segs) > 1 else None)
        if base_events:
            doc["base_events"] = [e.to_dict() for e in base_events]
        return doc

    def emit_progress() -> None:
        now = time.monotonic()
        with lock:
            if now - state["last_emit"] < PROGRESS_INTERVAL:
                return
            state["last_emit"] = now
            t = sum(sg.contribution(sg.progress_t) for sg in segs)
        on_progress(t, info.duration)

    def work(sg: _Seg) -> None:
        frm = max(sg.start, sg.progress_t - RESUME_BACK)
        detector = Detector(profile, h_scale)
        tracker = EventTracker(profile, resume_start=frm if frm > 0 else None)
        kw = {"end": sg.dec_end} if sg.dec_end is not None else {}
        stream = FrameStream(path, profile, start=frm, hwaccel=hwaccel, codec=info.codec, **kw)
        last_save = frm
        sg.progress_t = frm

        def snap(progress: float) -> None:
            sg.snap_events, sg.snap_spec = tracker.snapshot()
            sg.snap_progress = progress

        try:
            for t, banner, spec in stream:
                if stopped():
                    with lock:
                        snap(sg.progress_t)
                    return
                tracker.feed(t, detector.detect(banner, spec))
                sg.progress_t = t
                emit_progress()
                if t - last_save >= PARTIAL_EVERY:
                    last_save = t
                    with lock:
                        snap(t)
                        _save(cp, partial_doc(), cache_dir)
            sg.progress_t = sg.target
            sg.snap_events, sg.snap_spec = tracker.finish()
            sg.snap_progress = sg.progress_t
        finally:
            stream.close()

    todo = [sg for sg in segs if not sg.done]
    if len(todo) <= 1:
        for sg in todo:
            work(sg)
    else:
        errors: list[BaseException] = []
        with ThreadPoolExecutor(max_workers=len(todo)) as ex:
            futs = [ex.submit(work, sg) for sg in todo]
            for f in futs:
                try:
                    f.result()
                except BaseException as e:  # noqa: BLE001
                    abort.set()
                    errors.append(e)
        if errors:
            raise errors[0]

    if not all(sg.done for sg in segs):
        # 取消：寫入 partial（含各段進度）後離開；所有 FrameStream 已在各段工作內關閉
        _save(cp, partial_doc(), cache_dir)
        raise Cancelled()
    on_progress(info.duration, info.duration)

    raw, spectating = combined()
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
