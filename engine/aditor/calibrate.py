"""Per-video icon scale calibration (spec §5.1) handles HUD scaling and recordings below 1080p.

Icon templates use 1080p footage with HUD at 100%; icons differ in size at other HUD scales. Calibrate once by finding frames with score banners (an arrow and plus sign) and comparing them at each DEFAULT_SCALES value. Use the median of the best scales, then use that single scale for the rest of the video."""
from __future__ import annotations

import threading

import numpy as np

from .decode import FPS, FrameStream
from .detect import (Detector, KW_THRESHOLD, Keywords, _consensus, _match_max, hand_strip, knock_strip,
                     row_ink)
from .errors import Cancelled
from .icon_detect import DEFAULT_SCALES, IconDetector, IconFrame
from .models import VideoInfo
from .profile import Profile

WANTED_HITS = 5
PROBE_MIN = 0.45  # Initial single-scale (1.0) arrow-score threshold: a 10% scale deviation drops the score to 0.5–0.7; this only selects frames for multi-scale verification.


def pick_scale(scales: list[float]) -> float:
    """Return the median of the best scale for each hit frame (if between two scales, choose the one closest to 1.0); return 1.0 when there are no frames."""
    if not scales:
        return 1.0
    med = float(np.median(scales))
    return min(DEFAULT_SCALES, key=lambda s: (abs(s - med), abs(s - 1.0)))


def _collect(path: str, profile: Profile, probe: IconDetector, multi: IconDetector, start: float,
             budget: float, limit: float | None, cancel: threading.Event | None = None,
             codec: str | None = None, hwaccel: bool = True) -> tuple[list[float], float]:
    """Decode up to budget seconds from start (without exceeding the time limit); return (best scale for hit frames, actual seconds scanned)."""
    hits: list[float] = []
    scanned = 0.0
    stream = FrameStream(path, profile, start=start, codec=codec, hwaccel=hwaccel)
    try:
        for t, banner, spec in stream:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            if (limit is not None and t >= limit) or scanned >= budget:
                break
            scanned += 1.0 / FPS
            if probe.chev_best(banner)[0] < PROBE_MIN:
                continue
            f = multi.score_features(banner)
            if f.chev >= multi.p.chev_min and f.plus >= multi.p.plus_min:
                hits.append(f.chev_scale)
                if len(hits) >= WANTED_HITS:
                    break
    finally:
        stream.close()
    return hits, scanned


def calibrate(path: str, info: VideoInfo, profile: Profile, *,
              max_scan_seconds: float = 600.0,
              cancel: threading.Event | None = None, hwaccel: bool = True) -> float:
    """Decode from duration/2 (continue from 0 after reaching the end, up to max_scan_seconds total), collect frames with
    score banners, and return the best icon scale; return 1.0 if no such frames are found."""
    probe = IconDetector(profile.dir, scales=(1.0,))
    multi = IconDetector(profile.dir, scales=DEFAULT_SCALES)
    mid = info.duration / 2
    hits, scanned = _collect(path, profile, probe, multi, mid, max_scan_seconds, None, cancel,
                             info.codec, hwaccel)
    if len(hits) < WANTED_HITS and mid > 0 and scanned < max_scan_seconds:
        more, _ = _collect(path, profile, probe, multi, 0.0, max_scan_seconds - scanned, mid, cancel,
                           info.codec, hwaccel)
        hits += more[:WANTED_HITS - len(hits)]
    return pick_scale(hits)


# ---- Per-video kill keyword template learning (see detect.Keywords) ----
# Scan the first LEARN_SCAN_SECONDS of the video first (sparse mid-video kills may provide no anchors). If there are too few
# kills near the beginning to learn all templates, continue collecting anchors through the end and fill only missing templates
# (extend_keywords). Split the opening window across jobs; scan each segment fully unless its anchor limit is reached early.
# Merge results in timestamp order so learned templates do not depend on jobs (jobs=1 and jobs=4 produce the same result).
# analyze does not call learn_keywords: the main analysis learns with the same AnchorCollector/build_keywords while decoding
# (analyze._Learner), avoiding another decode pass. learn_keywords remains for standalone scanning and equivalence tests.
LEARN_SCAN_SECONDS = 900.0
ANCHOR_BANNERS = (4, 4)    # Number of earliest banners to use for assist and knock anchors (timestamps > 2 seconds apart count as separate banners).
ANCHORS_PER_BANNER = 2
KNOCK_ANCHOR_L2 = 0.05     # Knock anchor: net fine-stroke value on the damage line, plus a readable enemy-name fingerprint.
KNOCK_SIG_WIDTH = 40       # Minimum name-fingerprint width for a knock anchor.
KNOCK_SIG_DENSITY = 0.12   # Minimum name-fingerprint ink density for a knock anchor.
HAND_ANCHOR_MIN = 0.92     # Handshake score for an assist-elimination anchor.
MAX_ASSIST_CANDS = 80      # Maximum assist-knock candidate frames used to determine assist_by_knock.
ASSIST_BY_KNOCK_BANNERS = 2  # Number of distinct assist-knock banners containing the knock keyword required to treat this video's assist banners as containing it.
BANNER_GAP = 2.0           # Anchor timestamps farther apart than this count as separate banners.

Group = tuple[float, float, list]   # (first frame timestamp, last frame timestamp, anchor masks)


class _Anchors:
    def __init__(self, want: int):
        self.want = want
        self.groups: list[Group] = []

    def add(self, t: float, strip: np.ndarray) -> None:
        if self.groups and t - self.groups[-1][1] <= BANNER_GAP:
            t0, _, strips = self.groups[-1]
            if len(strips) < ANCHORS_PER_BANNER:
                strips.append(strip)
            self.groups[-1] = (t0, t, strips)
        elif len(self.groups) < self.want:
            self.groups.append((t, t, [strip]))

    @property
    def done(self) -> bool:
        return len(self.groups) >= self.want

    def accepts(self, t: float) -> bool:
        """Whether an anchor is still needed at this timestamp (the group limit is not reached, or it belongs to the last group)."""
        return not self.done or t - self.groups[-1][1] <= BANNER_GAP


def _merge_groups(parts: list[list[Group]], want: int) -> list[Group]:
    """Merge anchor groups from each segment in timestamp order (rejoin banners split at segment boundaries and take the earliest
    ANCHORS_PER_BANNER anchors by timestamp), then return the first want groups."""
    out: list[Group] = []
    for groups in parts:
        for t0, t1, strips in groups:
            if out and t0 - out[-1][1] <= BANNER_GAP:
                p0, _, ps = out[-1]
                out[-1] = (p0, t1, (ps + strips)[:ANCHORS_PER_BANNER])
            else:
                out.append((t0, t1, list(strips)))
    return out[:want]


def _hit_groups(cands: list, tpl: np.ndarray) -> int:
    hit_t = [t for t, m, px, ll in cands if _match_max(m[:, max(0, ll - 4):px], tpl) >= KW_THRESHOLD]
    return sum(1 for i, t in enumerate(hit_t) if i == 0 or t - hit_t[i - 1] > BANNER_GAP)


class AnchorCollector:
    """Feed frames one at a time and collect anchors for assist eliminations (handshake) and knocks (enemy-colored name plus damage line)."""

    def __init__(self, profile: Profile, det: Detector):
        self.profile, self.det = profile, det
        self.assist_cands: list[tuple[float, np.ndarray, int, int]] = []  # (t, first-line white-text mask, plus_x, line_l)
        self.hand, self.knock = _Anchors(ANCHOR_BANNERS[0]), _Anchors(ANCHOR_BANNERS[1])
        self._last_hit = -1e9
        self._hand_hw = det.icons.tpl["hand"][det.icon_scale].shape

    def full(self, t: float) -> bool:
        """Whether the limit has been reached and this segment needs no more scanning. Wait until the last anchor banner ends
        (silence > BANNER_GAP), or the final group's anchors may be truncated compared with an unsegmented scan."""
        return (self.hand.done and self.knock.done and len(self.assist_cands) >= MAX_ASSIST_CANDS
                and t - self._last_hit > BANNER_GAP)

    def feed(self, t: float, banner) -> None:
        det = self.det
        if not det.icons.maybe_banner(banner):
            return
        self.feed_features(t, banner, det.icons.features(banner))

    def feed_features(self, t: float, banner, f: IconFrame) -> None:
        """f contains the icon features already computed for this frame (reused during main analysis learning to avoid recomputation)."""
        if f.kind == "assist_elim" and f.hand >= HAND_ANCHOR_MIN and self.hand.accepts(t):
            s = hand_strip(banner, f, self._hand_hw, self.profile)
            if s is not None:
                self.hand.add(t, s)
                self._last_hit = t
        elif (f.kind == "assist_knock" and len(self.assist_cands) < MAX_ASSIST_CANDS
              and f.line2_ink - f.line2_ink_bg < 0.03 and f.name_color - f.name_color_bg < 20):
            # Assist-knock candidate: no damage line and no enemy-colored name (exclude knocks classified as assists).
            self.assist_cands.append((t, row_ink(banner, f, self.profile, pad=5), f.plus_x, f.line_l))
            self._last_hit = t
        elif f.kind == "knock" and f.line2_ink - f.line2_ink_bg >= KNOCK_ANCHOR_L2 and self.knock.accepts(t):
            # Reliable knock: has a damage line and a readable enemy-colored name fingerprint (red/yellow/pink; language-independent).
            sig = self.det._knock_sig(banner, f)
            if sig is not None and sig.width >= KNOCK_SIG_WIDTH and float(sig.bits.mean()) >= KNOCK_SIG_DENSITY:
                s = knock_strip(banner, f, self.profile)
                if s is not None:
                    self.knock.add(t, s)
                    self._last_hit = t


def build_keywords(cols: list[AnchorCollector]) -> Keywords:
    """Learn templates after merging collectors from each segment in timestamp order; templates with too few anchors (< 3 distinct banners) are None."""
    hand = _merge_groups([c.hand.groups for c in cols], ANCHOR_BANNERS[0])
    knock = _merge_groups([c.knock.groups for c in cols], ANCHOR_BANNERS[1])
    cands = sorted((x for c in cols for x in c.assist_cands), key=lambda x: x[0])[:MAX_ASSIST_CANDS]
    kw = Keywords(_consensus([s for _, _, ss in hand for s in ss], len(hand)),
                  _consensus([s for _, _, ss in knock for s in ss], len(knock)))
    if kw.knock is not None:
        # Count distinct assist-knock candidate banners (including non-kill banners) whose text contains the knock keyword.
        kw.assist_by_knock = _hit_groups(cands, kw.knock) >= ASSIST_BY_KNOCK_BANNERS
    return kw


def keywords_complete(kw: Keywords | None) -> bool:
    """Whether learned templates can verify every category without extended learning (see Detector._verify): knocks need a knock
    template; assist-knocks need an assist-prefix template or this video's assist banners must contain the knock keyword.
    Assist eliminations are uncommon, so requiring an assist prefix would make most videos extend learning to the end."""
    return kw is not None and kw.knock is not None and (kw.assist is not None or kw.assist_by_knock)


def extend_keywords(base: Keywords, wider: Keywords) -> Keywords:
    """Extended learning keeps templates learned in the initial window unchanged (same result as learning only the opening section)
    and fills only templates that could be learned after scanning a wider range. wider is the build_keywords result from collectors
    for both the initial and extended windows."""
    knock = base.knock if base.knock is not None else wider.knock
    by_knock = base.assist_by_knock if base.knock is not None else wider.assist_by_knock
    return Keywords(base.assist if base.assist is not None else wider.assist, knock, by_knock)


def same_keywords(a: Keywords | None, b: Keywords | None) -> bool:
    def eq(x, y):
        return (x is None and y is None) or (x is not None and y is not None and np.array_equal(x, y))
    a, b = a or Keywords(), b or Keywords()
    return eq(a.assist, b.assist) and eq(a.knock, b.knock) and a.assist_by_knock == b.assist_by_knock


def _scan_segment(path: str, profile: Profile, scale: float, start: float, end: float,
                  cancel: threading.Event | None, codec: str | None, hwaccel: bool,
                  abort: threading.Event | None = None) -> AnchorCollector:
    """abort is set by learn_keywords when another segment fails; stop this segment immediately instead of decoding it fully before reporting the error."""
    col = AnchorCollector(profile, Detector(profile, scale))
    stream = FrameStream(path, profile, start=start, end=end, codec=codec, hwaccel=hwaccel)
    try:
        for t, banner, spec in stream:
            if (cancel is not None and cancel.is_set()) or (abort is not None and abort.is_set()):
                raise Cancelled()
            col.feed(t, banner)
            if col.full(t):
                break
    finally:
        stream.close()
    return col


def learn_keywords(path: str, info: VideoInfo, profile: Profile, scale: float, *, jobs: int = 1,
                   max_scan_seconds: float = LEARN_SCAN_SECONDS, cancel: threading.Event | None = None,
                   hwaccel: bool = True) -> Keywords:
    """Scan the start of the video (up to max_scan_seconds) for assist-elimination and knock-banner anchors, then learn keyword
    templates (see build_keywords). If the opening section lacks enough kills to learn all templates, continue collecting
    through the end and fill only missing templates (see extend_keywords). Templates without enough anchors remain None
    (disabled; behavior falls back to icons only). jobs affects speed but not the result."""
    total = min(info.duration, max_scan_seconds)
    cols = _scan_head(path, info, profile, scale, total, jobs, cancel, hwaccel)
    base = build_keywords(cols)
    if keywords_complete(base) or total >= info.duration:
        return base
    late = _scan_segment(path, profile, scale, total, info.duration, cancel, info.codec, hwaccel)
    return extend_keywords(base, build_keywords(cols + [late]))


def _scan_head(path: str, info: VideoInfo, profile: Profile, scale: float, total: float, jobs: int,
               cancel: threading.Event | None, hwaccel: bool) -> list[AnchorCollector]:
    """Split [0, total) across jobs to collect anchors in parallel, and return the segment collectors sorted by timestamp."""
    n = max(1, min(int(jobs), int(total // 30)))
    bounds = [round(total * i / n / FPS_GRID) * FPS_GRID for i in range(n)] + [total]
    spans = [(bounds[i], bounds[i + 1]) for i in range(n)]
    if n == 1:
        return [_scan_segment(path, profile, scale, 0.0, total, cancel, info.codec, hwaccel)]
    from concurrent.futures import ThreadPoolExecutor
    abort = threading.Event()

    def scan(a: float, b: float) -> AnchorCollector:
        try:
            return _scan_segment(path, profile, scale, a, b, cancel, info.codec, hwaccel, abort)
        except BaseException:
            abort.set()  # One segment failed: stop all others immediately.
            raise

    cols: list[AnchorCollector] = []
    error: BaseException | None = None
    with ThreadPoolExecutor(max_workers=n) as ex:
        futs = [ex.submit(scan, a, b) for a, b in spans]
        for f in futs:
            try:
                cols.append(f.result())
            except BaseException as e:  # noqa: BLE001
                # Prefer the actual failure over Cancelled errors caused by another segment failing (all errors are Cancelled on user cancellation).
                if error is None or (isinstance(error, Cancelled) and not isinstance(e, Cancelled)):
                    error = e
    if error is not None:
        raise error
    return cols


FPS_GRID = 1.0 / FPS
