"""Analysis pipeline: probe → cache check → calibration → decode/detect/track events (learn keywords while decoding) → keyframes → derive → save (spec §4.2, §5.5)."""
from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import ENGINE_VERSION
from .aspect import detect_aspect, resolve_layout
from .cache import (cache_path, load_cache, merge_clips, merge_reanalysis,
                    needs_reanalysis, save_cache)
from .calibrate import (LEARN_SCAN_SECONDS, AnchorCollector, build_keywords, calibrate, extend_keywords,
                        keywords_complete, same_keywords)
from .decode import FrameStream, is_gpu_path
from .errors import Cancelled
from .derive import derive
from .detect import Detector, Keywords, Pending
from .events import EventTracker
from .layout import Layout
from .models import Clip, Event, FrameResult, SpecInterval
from .probe import keyframes, probe
from .profile import Profile

PARTIAL_EVERY = 30.0   # Write a partial every this many video seconds.
# When templates cannot be fully learned within the learning window, continue through the end of the video (see _Learner).
# Do not save segment progress during extended learning (cancellation restarts learning); this can be disabled to test resuming itself.
EXTEND_LEARNING = True
RESUME_BACK = 12.0     # On resume, move the ownership boundary back this many seconds (> the ~10-second maximum banner duration, so earlier banners are fully closed and stored).
PROGRESS_INTERVAL = 0.25  # Call on_progress at most once every 0.25 seconds of wall-clock time.
# Ownership-based merging for segmented decoding (C1): each segment emits only events whose first_t is in [start, end).
# To give the tracker the same context at the segment start as single-pass analysis, decode from start - SEGMENT_PREROLL
# as well (feed the tracker only; do not emit events). The tracker state contains only the in-progress banner run
# (there are no links across banners), so context needs to cover at most one ~10-second banner plus a gap. Use 20 seconds
# so tracker state at the segment start matches single-pass analysis (runs are independent when separated by >= 2 empty frames).
SEGMENT_PREROLL = 20.0
# Decode this many seconds beyond the segment end so banners that start within a segment and cross its boundary can finish
# (type majority vote, name fingerprint, and split detection).
SEGMENT_POSTROLL = 12.0
AUTO_MIN_SEGMENT = 30.0  # Minimum segment length (seconds) when jobs is automatic.
EXPLICIT_MIN_SEGMENT = 5.0  # Minimum segment length (seconds) when jobs is explicitly specified.
GRID = 0.25


Cancelled = Cancelled  # Re-export as aditor.analyze.Cancelled.


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
    """Keep only the portion within [lo, hi)."""
    out = []
    for i in items:
        a, b = max(i.start, lo), min(i.end, hi)
        if b > a:
            out.append(SpecInterval(a, b))
    return out


def _cut_intervals(items: list[SpecInterval], lo: float, hi: float) -> list[SpecInterval]:
    """Remove the [lo, hi) range (keeping the rest)."""
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
    """Split [0, duration] evenly into at most jobs segments (each at least min_len seconds), aligning boundaries to a 0.25-second grid.

    Return [(start, end)]; each segment owns events in [start, end) and decodes the range
    [start - SEGMENT_PREROLL, end + SEGMENT_POSTROLL] (the first segment starts at 0 and the last ends at EOF).
    """
    n = max(1, min(int(jobs), int(duration // min_len) if min_len > 0 else int(jobs)))
    bounds = [0.0]
    for i in range(1, n):
        bounds.append(round(duration * i / n / GRID) * GRID)
    bounds.append(duration)
    return [(bounds[i], bounds[i + 1]) for i in range(n)]


def auto_jobs(gpu_path: bool) -> int:
    """Automatic jobs: min(4, max(1, cpu // 4)) for the hardware path; 1 for the software path (dav1d is already multithreaded)."""
    if not gpu_path:
        return 1
    return min(4, max(1, (os.cpu_count() or 4) // 4))


@dataclass
class _Seg:
    start: float
    end: float          # Nominal end (ownership range [start, end); excludes post-roll decoding).
    last: bool
    duration: float
    progress_t: float = 0.0   # Progress for display/completion checks (monotonic; does not move backward when replaying context on resume).
    snap_progress: float = 0.0  # Tracker cursor corresponding to snap_events/snap_spec (for writing partials).
    snap_events: list = field(default_factory=list)
    snap_spec: list = field(default_factory=list)
    own_from: float = 0.0     # Time when this run begins owning output (greater than start on resume).

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
        """Return (ownership start, decode start). A new segment (or a cursor still in preroll context) owns from start
        and decodes from start - PREROLL. On resume, ownership moves back by RESUME_BACK, with PREROLL context added before it."""
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
    """Validate and restore segments from a partial; return None if the format is invalid."""
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
              segments: list[dict] | None = None, keywords: Keywords | None = None,
              aspect_source: str = "default") -> dict:
    """h_scale is the icon scale calibrated for this video (field name retained from an older version; None means not calibrated).
    aspect_source records where profile.layout came from: explicit, tag, detected, or default."""
    doc = {
        "version": 1,
        "video": info.to_dict(),
        "analysis": {"status": status, "progress_t": progress_t, "engine_version": ENGINE_VERSION,
                     "templates_version": profile.templates_version,
                     "h_scale": h_scale, "aspect_squash": profile.layout.squash, "aspect_source": aspect_source},
        "events": [e.to_dict() for e in events],
        "spectating": [s.to_dict() for s in spectating],
        "clips": [c.to_dict() for c in clips],
    }
    if segments:
        doc["analysis"]["segments"] = segments
    if keywords is not None:
        doc["analysis"]["keywords"] = keywords.to_dict()  # Keyword templates learned from this video (reused when resuming analysis).
    return doc


def _save(cp: Path, doc: dict, fallback: Path) -> Path:
    doc["cache_path"] = str(cp)
    written = save_cache(cp, doc, fallback_dir=fallback)
    if written != cp:
        doc["cache_path"] = str(written)
        save_cache(written, doc)
    return written


def _resumable(old: dict | None, info, profile: Profile, check_aspect: bool = True) -> bool:
    """check_aspect=False (untagged video, aspect detected) resumes whatever squash the partial holds."""
    if not old:
        return False
    a, v = old.get("analysis") or {}, old.get("video") or {}
    return (a.get("status") == "partial" and a.get("h_scale") is not None
            and v.get("size") == info.size
            and abs(float(v.get("mtime", -1.0)) - info.mtime) < 1e-6
            and a.get("engine_version") == ENGINE_VERSION
            and a.get("templates_version") == profile.templates_version
            and (not check_aspect or a.get("aspect_squash", 1.0) == profile.layout.squash))


class _Learner:
    """Learn keyword templates while decoding (replaces the separate decode pass at the start of the video in calibrate.learn_keywords).

    The learning window matches learn_keywords: [0, LEARN_SCAN_SECONDS) at the start of the video. Each segment collects
    anchors only in the intersection of its ownership range [start, end) and the learning window (excluding preroll/postroll context).
    Merge collectors in time order (build_keywords), producing the same templates as learn_keywords. Until all segments finish
    collecting, buffer frames that require keyword validation (Pending) and finalize them after learning completes.

    Extended learning: if the templates are incomplete within the learning window (few kills near the start), each segment
    continues collecting anchors in [learning window, segment end) (late_spans). After all segments finish, fill missing
    templates (finalize/extend_keywords), then finalize each segment again from its per-frame log without decoding again.
    Segments cannot know whether extension is needed until the learning window is complete, so collect and retain these logs
    in all cases and discard them only when extension is unnecessary."""

    def __init__(self, segs: list[_Seg], limit: float, duration: float):
        self.spans = [(sg.start, limit if sg.last else min(sg.end, limit)) for sg in segs]
        self.late_spans = [(max(sg.start, limit), duration if sg.last else sg.end) for sg in segs]
        self.cols: list[AnchorCollector | None] = [None] * len(segs)
        self.late_cols: list[AnchorCollector | None] = [None] * len(segs)
        self._waiting = {i for i, (a, b) in enumerate(self.spans) if b > a}
        self._lock = threading.Lock()
        self.ready = threading.Event()
        self.keywords: Keywords | None = None
        self.final: Keywords | None = None  # Final templates after finalize, including extended learning.
        if not self._waiting:
            self._build()

    def collector(self, i: int, profile: Profile, det: Detector) -> AnchorCollector | None:
        if i not in self._waiting:
            return None
        self.cols[i] = AnchorCollector(profile, det)
        return self.cols[i]

    def late_collector(self, i: int, profile: Profile, det: Detector) -> AnchorCollector | None:
        a, b = self.late_spans[i]
        if b <= a or not EXTEND_LEARNING:
            return None
        self.late_cols[i] = AnchorCollector(profile, det)
        return self.late_cols[i]

    @property
    def late(self) -> bool:
        """Whether extended learning is needed: the learning window is complete, templates are incomplete, and video remains (always False before learning completes)."""
        return (EXTEND_LEARNING and self.ready.is_set() and not keywords_complete(self.keywords)
                and any(b > a for a, b in self.late_spans))

    def finalize(self) -> bool:
        """Choose the final templates after all segments finish; return whether extended learning changed them (segments must then be re-finalized from their per-frame logs)."""
        if not self.late:
            self.final = self.keywords
            return False
        cols = [c for c in self.cols if c is not None] + [c for c in self.late_cols if c is not None]
        self.final = extend_keywords(self.keywords, build_keywords(cols))
        return not same_keywords(self.final, self.keywords)

    def finish(self, i: int) -> None:
        with self._lock:
            if i not in self._waiting:
                return
            self._waiting.discard(i)
            if not self._waiting:
                self._build()

    def _build(self) -> None:
        self.keywords = build_keywords([c for c in self.cols if c is not None])
        self.ready.set()


def _replay(sg: _Seg, log: list, own_from: float, hi: float, det: Detector, profile: Profile) -> None:
    """Re-finalize a segment from its per-frame log using the final templates after extended learning, without decoding again."""
    tracker = EventTracker(profile)
    for t, r in log:
        tracker.feed(t, det.resolve(r))
    events, intervals = tracker.finish()
    sg.snap_events = [e for e in events if sg.owns(e.t)]
    sg.snap_spec = _clip_intervals(intervals, own_from, hi)


def analyze(path: str, profile: Profile, *, cache_dir: Path, beside: bool = False,
            force: bool = False, on_progress: Callable[[float, float], None] = _noop,
            cancel: threading.Event | None = None, hwaccel: bool = True,
            jobs: int | None = None, layout: Layout | None = None) -> dict:
    info = probe(path)
    if layout is None and not profile.layout.identity:
        layout = profile.layout  # Retain explicit profile layouts for existing callers.
    # Explicit > video tag > detection; None means detect when the video is decoded (cache hits never detect).
    layout, aspect_source = resolve_layout(layout, info)
    profile = profile.with_layout(layout or Layout(1.0))
    cache_dir = Path(cache_dir)
    cp = cache_path(path, cache_dir, beside)
    old = load_cache(cp)
    # An untagged video's cache records the detected squash, so accept whichever it holds.
    squash = None if layout is None else profile.layout.squash
    if not force and old is not None and not needs_reanalysis(old, info, profile.templates_version, squash):
        old["cache_path"] = str(cp)
        return old

    resuming = (not force) and _resumable(old, info, profile, squash is not None)
    old_clips = [Clip.from_dict(c) for c in (old or {}).get("clips", [])]
    segs: list[_Seg] | None = None
    if resuming:
        raw_segs = old["analysis"].get("segments")
        if raw_segs:
            segs = _segments_from_doc(raw_segs, info.duration)
            resuming = segs is not None  # Invalid format means there is no resumable partial.
    if resuming:
        if layout is None:  # Reuse the squash detected by the interrupted run instead of detecting again.
            a = old["analysis"]
            layout, aspect_source = Layout(float(a.get("aspect_squash", 1.0))), a.get("aspect_source", "default")
            profile = profile.with_layout(layout)
        h_scale = float(old["analysis"].get("h_scale", 1.0))
        kw_doc = old["analysis"].get("keywords")
        try:
            keywords = Keywords.from_dict(kw_doc) if kw_doc is not None else None
        except ValueError:
            keywords = None  # Corrupt templates in the partial: relearn and replan all segments, effectively restarting analysis.
        done_events = [Event.from_dict(e) for e in old.get("events", [])]
        done_spec = [SpecInterval.from_dict(s) for s in old.get("spectating", [])]
        base_raw = old.get("base_events")  # Events from before reanalysis, including user state; merge them on completion.
        if segs is None:  # Legacy partial without segments: treat as one segment and resume from progress_t.
            p = float(old["analysis"].get("progress_t", 0.0))
            segs = [_Seg(0.0, info.duration, True, info.duration, p, p)]
    else:
        h_scale = None  # Calibrate after base_events is ready (this can be cancelled).
        keywords = None
        done_events, done_spec = [], []
        base_raw = None
        if old is not None:
            partial = (old.get("analysis") or {}).get("status") == "partial"
            base_raw = old.get("base_events") if partial else old.get("events")
    base_events = [Event.from_dict(e) for e in base_raw] if base_raw else []
    manual_clips = merge_clips(old_clips, [])
    learner: _Learner | None = None
    if h_scale is None or keywords is None:
        try:
            if layout is None:
                detection = detect_aspect(path, info, cancel=cancel, hwaccel=hwaccel)
                layout, aspect_source = detection.layout, "detected" if detection.found else "default"
                profile = profile.with_layout(layout)
            if h_scale is None:
                h_scale = calibrate(path, info, profile, cancel=cancel, hwaccel=hwaccel)
        except Cancelled:
            doc = _make_doc(info, profile, "partial", 0.0, None, [], [], manual_clips,  # h_scale=None means not calibrated yet.
                            aspect_source=aspect_source)
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
        learner = _Learner(segs, min(info.duration, LEARN_SCAN_SECONDS), info.duration)

    # Ownership: each segment emits only events starting at or after own_from (start for a new segment, or the resumed
    # cursor moved back by RESUME_BACK) and before its end. Keep stored partial events only for completed segments and
    # for timestamps before own_from in unfinished segments; regenerate the rest during replay.
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
    abort = threading.Event()  # Signal other segments to stop if one fails.
    state = {"last_emit": -1e9}

    def stopped() -> bool:
        return abort.is_set() or (cancel is not None and cancel.is_set())

    def combined():
        # Ownership-based merging gives each segment a disjoint output range, so fingerprint deduplication is unnecessary and not performed.
        evs = list(kept_events)
        spec = list(kept_spec)
        for sg in segs:
            evs += sg.snap_events
            spec += sg.snap_spec
        return sorted(evs, key=lambda e: e.t), _merge_intervals(spec)

    def learned() -> Keywords | None:
        """Finalized templates; None while the learning window is incomplete or extended learning is in progress (partials omit unfinalized templates and relearn them on resume)."""
        if learner is None:
            return keywords
        if learner.final is not None:
            return learner.final
        return learner.keywords if learner.ready.is_set() and not learner.late else None

    replays: dict[int, tuple[list, float, float]] = {}  # For extended learning: segment -> (per-frame log, own_from, hi).

    def partial_doc() -> dict:
        kw = learned()
        if kw is None:
            # Keywords are not ready, so buffered frames cannot be finalized. Save only calibration results; resume replans segments and relearns while decoding from the start.
            doc = _make_doc(info, profile, "partial", 0.0, h_scale, [], [], manual_clips, aspect_source=aspect_source)
        else:
            evs, spec = combined()
            doc = _make_doc(info, profile, "partial", sum(sg.contribution(sg.snap_progress) for sg in segs),
                            h_scale, evs, spec, manual_clips,
                            [sg.to_dict() for sg in segs] if len(segs) > 1 else None, kw, aspect_source)
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

    def work(i: int, sg: _Seg) -> None:
        own_from, frm = sg.resume_plan()
        detector = Detector(profile, h_scale, keywords=keywords)
        tracker = EventTracker(profile)
        col = learn_lo = learn_hi = late_col = late_lo = late_hi = None
        buf: list[tuple[float, FrameResult | Pending]] | None = None  # Buffer before keywords finish learning (None means frames can be finalized immediately).
        log: list[tuple[float, FrameResult | Pending]] | None = None  # Per-frame log for extended learning (None when extension is unnecessary).
        if learner is not None:
            col = learner.collector(i, profile, detector)
            learn_lo, learn_hi = learner.spans[i]
            late_col = learner.late_collector(i, profile, detector)
            if late_col is not None:
                late_lo, late_hi = learner.late_spans[i]
            buf, log = [], []

        def flush() -> bool:
            """After keyword learning completes, finalize the buffer and switch to direct finalization; return whether direct finalization is ready."""
            nonlocal buf
            if buf is None:
                return True
            if not learner.ready.is_set():
                return False
            detector.set_keywords(learner.keywords)
            for bt, br in buf:
                tracker.feed(bt, detector.resolve(br))
            buf = None
            return True
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
                    if flush():  # Do not save segment progress before keyword learning completes (partials store calibration results only).
                        with lock:
                            snap(cursor)
                    return
                r, f = detector.prepare(banner, spec)
                if col is not None:
                    if learn_lo - 1e-6 <= t < learn_hi - 1e-6:
                        col.feed_features(t, banner, f)
                    if t >= learn_hi - 1e-6 or col.full(t):
                        col = None
                        learner.finish(i)
                if log is not None:
                    if learner.ready.is_set() and not learner.late:
                        log = late_col = None  # Learning window is complete: no extended learning is needed.
                    else:
                        log.append((t, r))
                        if late_col is not None and late_lo - 1e-6 <= t < late_hi - 1e-6:
                            late_col.feed_features(t, banner, f)
                            if late_col.full(t):
                                late_col = None
                if flush():
                    tracker.feed(t, detector.resolve(r))
                else:
                    buf.append((t, r))
                cursor = t
                if t > sg.progress_t:
                    sg.progress_t = t
                emit_progress()
                if buf is None and log is None and t - last_save >= PARTIAL_EVERY:
                    last_save = t
                    with lock:
                        snap(t)
                        _save(cp, partial_doc(), cache_dir)
            if learner is not None:
                learner.finish(i)  # The stream reached EOF before the learning window ended.
                while not flush():  # Wait for other segments to finish scanning the learning window.
                    if not learner.ready.wait(0.1) and stopped():
                        return
            if log is not None and learner.late:
                replays[i] = (log, own_from, hi)  # Re-finalize in _replay after all segments finish and final templates are chosen.
            events, intervals = tracker.finish()
            with lock:
                sg.snap_events = [e for e in events if sg.owns(e.t)]
                sg.snap_spec = _clip_intervals(intervals, own_from, hi)
                sg.snap_progress = sg.progress_t = sg.target
        except BaseException:
            abort.set()  # Stop other segments immediately (I7); do not wait for them to finish.
            raise
        finally:
            stream.close()

    todo = [sg for sg in segs if not sg.done]
    errors: list[BaseException] = []
    if len(todo) <= 1:
        for sg in todo:
            try:
                work(segs.index(sg), sg)
            except BaseException as e:  # noqa: BLE001
                errors.append(e)
    else:
        with ThreadPoolExecutor(max_workers=len(todo)) as ex:
            futs = [ex.submit(work, segs.index(sg), sg) for sg in todo]
            for f in futs:
                try:
                    f.result()
                except BaseException as e:  # noqa: BLE001
                    abort.set()
                    errors.append(e)
    if errors:
        # Segment failed: preserve completed progress for the next resume, then pass the first error to the caller.
        try:
            with lock:
                _save(cp, partial_doc(), cache_dir)
        except Exception:
            pass
        raise errors[0]

    if not all(sg.done for sg in segs):
        # Cancelled: write a partial with each segment's progress and return; each FrameStream has already been closed by its segment worker.
        _save(cp, partial_doc(), cache_dir)
        raise Cancelled()
    if learner is not None and learner.finalize():
        det = Detector(profile, h_scale, keywords=learner.final)
        for i, (log, own_from, hi) in replays.items():
            _replay(segs[i], log, own_from, hi, det, profile)
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
                    keywords=learned(), aspect_source=aspect_source)
    doc["keyframes"] = kf
    doc["unmatched"] = [e.to_dict() for e in unmatched]
    _save(cp, doc, cache_dir)
    return doc
