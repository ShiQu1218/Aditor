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
from .calibrate import calibrate, learn_keywords
from .decode import FrameStream, is_gpu_path
from .errors import Cancelled
from .derive import derive
from .detect import Detector, Keywords
from .events import EventTracker
from .models import Clip, Event, SpecInterval
from .probe import keyframes, probe
from .profile import Profile

PARTIAL_EVERY = 30.0   # 每隔多少「影片秒」寫一次 partial
RESUME_BACK = 12.0     # 接續時，擁有範圍回退秒數（> 單一橫幅最長約 10 秒：此時間之前開始的橫幅一定已完整結束並存入）
PROGRESS_INTERVAL = 0.25  # on_progress 至多每 0.25 秒（實際時間）一次
# 切段解碼的「擁有權」合併（C1）：每段只輸出 first_t 落在 [start, end) 的事件；為了讓追蹤器在段起點
# 擁有與單段分析相同的上下文，每段另外從 start - SEGMENT_PREROLL 起解碼（只餵追蹤器、不輸出事件）。
# 追蹤器的狀態只有「進行中的橫幅 run」（沒有跨橫幅連結），上下文只需涵蓋單一橫幅最長約 10 秒＋一段空白；
# 取 20 秒，讓段起點的追蹤器狀態與單段分析相同（run 之間只要有 ≥2 格空白就互相獨立）。
SEGMENT_PREROLL = 20.0
# 段尾往後多解碼的秒數，讓「在段內開始、跨過段界」的橫幅完整收尾（類型多數決、名字指紋、分裂判定）。
SEGMENT_POSTROLL = 12.0
AUTO_MIN_SEGMENT = 30.0  # 自動 jobs 時每段至少多長（秒）
EXPLICIT_MIN_SEGMENT = 5.0  # 明確指定 jobs 時每段至少多長（秒）
GRID = 0.25


Cancelled = Cancelled  # 重新匯出：apexhl.analyze.Cancelled


def _noop(t: float, duration: float) -> None:
    pass


def _merge_intervals(items: list[SpecInterval]) -> list[SpecInterval]:
    out: list[SpecInterval] = []
    for s in sorted(items, key=lambda i: i.start):
        if out and s.start <= out[-1].end:
            out[-1] = SpecInterval(out[-1].start, max(out[-1].end, s.end))
        else:
            out.append(SpecInterval(s.start, s.end))
    return out


def _clip_intervals(items: list[SpecInterval], lo: float, hi: float) -> list[SpecInterval]:
    """只留 [lo, hi) 內的部分。"""
    out = []
    for i in items:
        a, b = max(i.start, lo), min(i.end, hi)
        if b > a:
            out.append(SpecInterval(a, b))
    return out


def _cut_intervals(items: list[SpecInterval], lo: float, hi: float) -> list[SpecInterval]:
    """挖掉 [lo, hi) 範圍（保留其餘部分）。"""
    out = []
    for i in items:
        if i.end <= lo or i.start >= hi:
            out.append(SpecInterval(i.start, i.end))
            continue
        if i.start < lo:
            out.append(SpecInterval(i.start, lo))
        if i.end > hi:
            out.append(SpecInterval(hi, i.end))
    return out


def plan_segments(duration: float, jobs: int, *, min_len: float = AUTO_MIN_SEGMENT) -> list[tuple[float, float]]:
    """把 [0, duration] 平均切成最多 jobs 段（每段至少 min_len 秒），邊界對齊 0.25 秒格線。

    回傳 [(start, end)]；每段的事件擁有範圍為 [start, end)，解碼範圍為
    [start - SEGMENT_PREROLL, end + SEGMENT_POSTROLL]（第一段從 0 起、最後一段到片尾）。
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
    end: float          # 名目結尾（擁有範圍 [start, end)；不含後延解碼）
    last: bool
    duration: float
    progress_t: float = 0.0   # 顯示／完成判斷用進度（單調不減；接續重播上下文時不倒退）
    snap_progress: float = 0.0  # 與 snap_events/snap_spec 對應的追蹤器游標（寫入 partial 用）
    snap_events: list = field(default_factory=list)
    snap_spec: list = field(default_factory=list)
    own_from: float = 0.0     # 本次執行開始擁有輸出權的時間（接續時 > start）

    @property
    def dec_end(self) -> float | None:
        return None if self.last else min(self.end + SEGMENT_POSTROLL, self.duration)

    @property
    def target(self) -> float:
        return self.end if self.last else self.dec_end

    @property
    def done(self) -> bool:
        return self.progress_t >= self.target - 1e-6

    def resume_plan(self) -> tuple[float, float]:
        """(擁有輸出權的起點, 解碼起點)。新段（或游標還在前置上下文內）從 start 擁有、解碼自 start - PREROLL；
        接續則回退 RESUME_BACK 後重新擁有，並同樣往前補足 PREROLL 上下文。"""
        if self.snap_progress <= self.start + 1e-6:
            own = self.start
        else:
            own = max(self.start, self.snap_progress - RESUME_BACK)
        return own, max(0.0, own - SEGMENT_PREROLL)

    def owns(self, t: float) -> bool:
        return t >= self.own_from - 1e-6 and (self.last or t < self.end - 1e-6)

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


def _make_doc(info, profile: Profile, status: str, progress_t: float, h_scale: float | None,
              events: list[Event], spectating: list[SpecInterval], clips: list[Clip],
              segments: list[dict] | None = None, keywords: Keywords | None = None) -> dict:
    """h_scale＝本支影片校準出的圖示尺度（欄位名沿用舊版，None＝尚未校準）。"""
    doc = {
        "version": 1,
        "video": info.to_dict(),
        "analysis": {"status": status, "progress_t": progress_t, "engine_version": ENGINE_VERSION,
                     "templates_version": profile.templates_version,
                     "h_scale": h_scale},
        "events": [e.to_dict() for e in events],
        "spectating": [s.to_dict() for s in spectating],
        "clips": [c.to_dict() for c in clips],
    }
    if segments:
        doc["analysis"]["segments"] = segments
    if keywords is not None:
        doc["analysis"]["keywords"] = keywords.to_dict()  # 這支影片學到的擊殺關鍵字樣板（接續分析沿用）
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


def _learn_jobs(info, jobs: int | None, hwaccel: bool) -> int:
    return auto_jobs(is_gpu_path(info.codec, hwaccel)) if jobs is None else max(1, int(jobs))


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
    segs: list[_Seg] | None = None
    if resuming:
        raw_segs = old["analysis"].get("segments")
        if raw_segs:
            segs = _segments_from_doc(raw_segs, info.duration)
            resuming = segs is not None  # 格式不符就當作沒有可接續的 partial
    if resuming:
        h_scale = float(old["analysis"].get("h_scale", 1.0))
        kw_doc = old["analysis"].get("keywords")
        keywords = Keywords.from_dict(kw_doc) if kw_doc is not None else None
        done_events = [Event.from_dict(e) for e in old.get("events", [])]
        done_spec = [SpecInterval.from_dict(s) for s in old.get("spectating", [])]
        base_raw = old.get("base_events")  # 重新分析前的舊事件（含使用者狀態），完成時合併
        if segs is None:  # 沒有 segments 的舊 partial：視為單一段，從 progress_t 接續
            p = float(old["analysis"].get("progress_t", 0.0))
            segs = [_Seg(0.0, info.duration, True, info.duration, p, p)]
    else:
        h_scale = None  # 於 base_events 備妥後校準（可被取消）
        keywords = None
        done_events, done_spec = [], []
        base_raw = None
        if old is not None:
            partial = (old.get("analysis") or {}).get("status") == "partial"
            base_raw = old.get("base_events") if partial else old.get("events")
    base_events = [Event.from_dict(e) for e in base_raw] if base_raw else []
    manual_clips = merge_clips(old_clips, [])
    if h_scale is None or keywords is None:
        try:
            if h_scale is None:
                h_scale = calibrate(path, info, profile, cancel=cancel, hwaccel=hwaccel)
            keywords = learn_keywords(path, info, profile, h_scale, cancel=cancel, hwaccel=hwaccel,
                                      jobs=_learn_jobs(info, jobs, hwaccel))
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

    # 擁有權：每段只輸出 own_from（新段＝start；接續＝游標回退 RESUME_BACK）之後、段尾之前開始的事件。
    # 已存入 partial 的舊事件只保留「已完成段」與「各未完成段 own_from 之前」的部分，其餘由重新播放產生。
    for sg in segs:
        sg.own_from = sg.end if sg.done else sg.resume_plan()[0]

    def _kept_old(e: Event) -> bool:
        for sg in segs:
            if sg.start - 1e-6 <= e.t and (sg.last or e.t < sg.end - 1e-6):
                return sg.done or e.t < sg.own_from - 1e-6
        return True

    kept_events = [e for e in done_events if _kept_old(e)]
    kept_spec = list(done_spec)
    for sg in segs:
        if not sg.done:
            kept_spec = _cut_intervals(kept_spec, sg.own_from, float("inf") if sg.last else sg.end)

    lock = threading.Lock()
    abort = threading.Event()  # 某段失敗時通知其他段停止
    state = {"last_emit": -1e9}

    def stopped() -> bool:
        return abort.is_set() or (cancel is not None and cancel.is_set())

    def combined():
        # 擁有權合併：各段輸出範圍互不重疊，不需要（也不做）指紋去重
        evs = list(kept_events)
        spec = list(kept_spec)
        for sg in segs:
            evs += sg.snap_events
            spec += sg.snap_spec
        return sorted(evs, key=lambda e: e.t), _merge_intervals(spec)

    def partial_doc() -> dict:
        evs, spec = combined()
        doc = _make_doc(info, profile, "partial", sum(sg.contribution(sg.snap_progress) for sg in segs),
                        h_scale, evs, spec, manual_clips,
                        [sg.to_dict() for sg in segs] if len(segs) > 1 else None, keywords)
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
        own_from, frm = sg.resume_plan()
        detector = Detector(profile, h_scale, keywords=keywords)
        tracker = EventTracker(profile)
        kw = {"end": sg.dec_end} if sg.dec_end is not None else {}
        stream = FrameStream(path, profile, start=frm, hwaccel=hwaccel, codec=info.codec, **kw)
        last_save = frm
        cursor = frm
        hi = float("inf") if sg.last else sg.end

        def snap(progress: float) -> None:
            evs, spec = tracker.snapshot()
            sg.snap_events = [e for e in evs if sg.owns(e.t)]
            sg.snap_spec = _clip_intervals(spec, own_from, hi)
            sg.snap_progress = progress

        try:
            for t, banner, spec in stream:
                if stopped():
                    with lock:
                        snap(cursor)
                    return
                tracker.feed(t, detector.detect(banner, spec))
                cursor = t
                if t > sg.progress_t:
                    sg.progress_t = t
                emit_progress()
                if t - last_save >= PARTIAL_EVERY:
                    last_save = t
                    with lock:
                        snap(t)
                        _save(cp, partial_doc(), cache_dir)
            events, intervals = tracker.finish()
            with lock:
                sg.snap_events = [e for e in events if sg.owns(e.t)]
                sg.snap_spec = _clip_intervals(intervals, own_from, hi)
                sg.snap_progress = sg.progress_t = sg.target
        except BaseException:
            abort.set()  # 其他段立刻停止（I7），不必等到它們跑完
            raise
        finally:
            stream.close()

    todo = [sg for sg in segs if not sg.done]
    errors: list[BaseException] = []
    if len(todo) <= 1:
        for sg in todo:
            try:
                work(sg)
            except BaseException as e:  # noqa: BLE001
                errors.append(e)
    else:
        with ThreadPoolExecutor(max_workers=len(todo)) as ex:
            futs = [ex.submit(work, sg) for sg in todo]
            for f in futs:
                try:
                    f.result()
                except BaseException as e:  # noqa: BLE001
                    abort.set()
                    errors.append(e)
    if errors:
        # 段失敗：先保留已完成的進度（下次可接續），再把第一個錯誤交給呼叫者
        try:
            with lock:
                _save(cp, partial_doc(), cache_dir)
        except Exception:
            pass
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
    doc = _make_doc(info, profile, "done", info.duration, h_scale, final, spectating, manual_clips,
                    keywords=keywords)
    doc["keyframes"] = kf
    doc["unmatched"] = [e.to_dict() for e in unmatched]
    _save(cp, doc, cache_dir)
    return doc
