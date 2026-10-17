"""每支影片的圖示尺度校準（spec §5.1）：處理 HUD 縮放與非 1080p 錄影。

圖示樣板取自 1080p、HUD 100%；其他 HUD 縮放下圖示大小不同。校準一次：找到幾個有加分橫幅的畫格
（箭頭＋「+」號），在 DEFAULT_SCALES 各尺度比對，取最佳尺度的中位數；之後整支影片只用這一個尺度（速度）。"""
from __future__ import annotations

import threading

import numpy as np

from .decode import FPS, FrameStream
from .detect import (Detector, KW_THRESHOLD, Keywords, _consensus, _match_max, hand_strip, knock_strip,
                     row_ink)
from .errors import Cancelled
from .icon_detect import DEFAULT_SCALES, IconDetector
from .models import VideoInfo
from .profile import Profile

WANTED_HITS = 5
PROBE_MIN = 0.45  # 單尺度（1.0）箭頭分數的初篩門檻：尺度偏離 10% 時分數會掉到 0.5–0.7，此門檻只用來挑出值得做多尺度驗證的畫格


def pick_scale(scales: list[float]) -> float:
    """各命中畫格的最佳尺度 → 中位數（落在兩個尺度之間時取最接近 1.0 的那個）；無畫格回傳 1.0。"""
    if not scales:
        return 1.0
    med = float(np.median(scales))
    return min(DEFAULT_SCALES, key=lambda s: (abs(s - med), abs(s - 1.0)))


def _collect(path: str, profile: Profile, probe: IconDetector, multi: IconDetector, start: float,
             budget: float, limit: float | None, cancel: threading.Event | None = None,
             codec: str | None = None, hwaccel: bool = True) -> tuple[list[float], float]:
    """從 start 解碼最多 budget 秒（且不超過時間 limit），回傳 (命中畫格的最佳尺度, 實際掃描秒數)。"""
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
            f = multi.features(banner)
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
    """從 duration/2 起解碼（到尾端後從 0 繼續，總計最多 max_scan_seconds），
    收集有加分橫幅的畫格，回傳最佳圖示尺度；一張都沒有則 1.0。"""
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


# ---- 擊殺關鍵字樣板的學習（每支影片一次，見 detect.Keywords） ----
# 掃描影片開頭 LEARN_SCAN_SECONDS 秒（稀疏的影片中段可能一個錨點也沒有），依 jobs 切段平行；每段完整掃描
# （只有該段已蒐集滿上限時提早結束），結果依時間排序合併，因此學到的樣板與 jobs 無關（jobs=1／4 一致）。
LEARN_SCAN_SECONDS = 900.0
ANCHOR_BANNERS = (4, 4)    # 助攻、擊倒錨點各取前這麼多個「橫幅」（時間相隔 > 2 秒算不同橫幅）
ANCHORS_PER_BANNER = 2
KNOCK_ANCHOR_L2 = 0.05     # 擊倒錨點：傷害行細筆畫淨值（＋讀得到像樣的敵人名字指紋）
KNOCK_SIG_WIDTH = 40       # 擊倒錨點：名字指紋最小寬度
KNOCK_SIG_DENSITY = 0.12   # 擊倒錨點：名字指紋最小墨密度
HAND_ANCHOR_MIN = 0.92     # 助攻消滅錨點：握手分數
MAX_ASSIST_CANDS = 80      # 判斷 assist_by_knock 用的助攻擊倒候選畫格上限
ASSIST_BY_KNOCK_BANNERS = 2  # 至少這麼多個不同橫幅的助攻擊倒含擊倒關鍵字，才算這支影片的助攻橫幅含擊倒關鍵字
BANNER_GAP = 2.0           # 錨點時間相隔超過這麼多秒＝不同橫幅

Group = tuple[float, float, list]   # (第一格時間, 最後一格時間, 錨點遮罩們)


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
        """還需要這個時間點的錨點嗎（群數沒滿，或仍屬最後一個群）。"""
        return not self.done or t - self.groups[-1][1] <= BANNER_GAP


def _merge_groups(parts: list[list[Group]], want: int) -> list[Group]:
    """各段的錨點群依時間合併（被段界切開的同一橫幅接回去，錨點取時間上最早的 ANCHORS_PER_BANNER 個），取前 want 個。"""
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
    """逐格餵畫面，蒐集助攻消滅（握手）與擊倒（敵人色名字＋傷害行）的錨點。"""

    def __init__(self, profile: Profile, det: Detector):
        self.profile, self.det = profile, det
        self.assist_cands: list[tuple[float, np.ndarray, int, int]] = []  # (t, 第一行白字遮罩, plus_x, line_l)
        self.hand, self.knock = _Anchors(ANCHOR_BANNERS[0]), _Anchors(ANCHOR_BANNERS[1])
        self._last_hit = -1e9
        self._hand_hw = det.icons.tpl["hand"][det.icon_scale].shape

    def full(self, t: float) -> bool:
        """已蒐集滿上限（本段不需要再掃）；要等最後一個錨點橫幅結束（靜默 > BANNER_GAP）才算，
        否則最後一群的錨點會被截斷，與不切段時不同。"""
        return (self.hand.done and self.knock.done and len(self.assist_cands) >= MAX_ASSIST_CANDS
                and t - self._last_hit > BANNER_GAP)

    def feed(self, t: float, banner) -> None:
        det = self.det
        if not det.icons.maybe_banner(banner):
            return
        f = det.icons.features(banner)
        if f.kind == "assist_elim" and f.hand >= HAND_ANCHOR_MIN and self.hand.accepts(t):
            s = hand_strip(banner, f, self._hand_hw, self.profile)
            if s is not None:
                self.hand.add(t, s)
                self._last_hit = t
        elif (f.kind == "assist_knock" and len(self.assist_cands) < MAX_ASSIST_CANDS
              and f.line2_ink - f.line2_ink_bg < 0.03 and f.name_color - f.name_color_bg < 20):
            # 助攻擊倒候選：沒有傷害行、沒有敵人色名字（排除被判成助攻的擊倒）
            self.assist_cands.append((t, row_ink(banner, f, self.profile, pad=5), f.plus_x, f.line_l))
            self._last_hit = t
        elif f.kind == "knock" and f.line2_ink - f.line2_ink_bg >= KNOCK_ANCHOR_L2 and self.knock.accepts(t):
            # 可靠的擊倒＝有傷害行，且讀得到像樣的敵人色名字指紋（紅／黃／粉紅皆可，與語言無關）
            sig = self.det._knock_sig(banner, f)
            if sig is not None and sig.width >= KNOCK_SIG_WIDTH and float(sig.bits.mean()) >= KNOCK_SIG_DENSITY:
                s = knock_strip(banner, f, self.profile)
                if s is not None:
                    self.knock.add(t, s)
                    self._last_hit = t


def build_keywords(cols: list[AnchorCollector]) -> Keywords:
    """各段收集器（依時間順序）合併後學出樣板；沒有足夠錨點（< 3 個不同橫幅）的樣板為 None。"""
    hand = _merge_groups([c.hand.groups for c in cols], ANCHOR_BANNERS[0])
    knock = _merge_groups([c.knock.groups for c in cols], ANCHOR_BANNERS[1])
    cands = sorted((x for c in cols for x in c.assist_cands), key=lambda x: x[0])[:MAX_ASSIST_CANDS]
    kw = Keywords(_consensus([s for _, _, ss in hand for s in ss], len(hand)),
                  _consensus([s for _, _, ss in knock for s in ss], len(knock)))
    if kw.knock is not None:
        # 助攻擊倒候選（含非擊殺橫幅）中，有多少個不同橫幅的字含擊倒關鍵字
        kw.assist_by_knock = _hit_groups(cands, kw.knock) >= ASSIST_BY_KNOCK_BANNERS
    return kw


def _scan_segment(path: str, profile: Profile, scale: float, start: float, end: float,
                  cancel: threading.Event | None, codec: str | None, hwaccel: bool) -> AnchorCollector:
    col = AnchorCollector(profile, Detector(profile, scale))
    stream = FrameStream(path, profile, start=start, end=end, codec=codec, hwaccel=hwaccel)
    try:
        for t, banner, spec in stream:
            if cancel is not None and cancel.is_set():
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
    """掃描影片開頭（最多 max_scan_seconds）蒐集助攻消滅與擊倒橫幅的錨點，學出關鍵字樣板（見 build_keywords）。
    沒有足夠錨點的樣板為 None（不啟用，行為退回只看圖示）。jobs 只影響速度，結果與 jobs 無關。"""
    total = min(info.duration, max_scan_seconds)
    n = max(1, min(int(jobs), int(total // 30)))
    bounds = [round(total * i / n / FPS_GRID) * FPS_GRID for i in range(n)] + [total]
    spans = [(bounds[i], bounds[i + 1]) for i in range(n)]
    if n == 1:
        return build_keywords([_scan_segment(path, profile, scale, 0.0, total, cancel, info.codec, hwaccel)])
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=n) as ex:
        futs = [ex.submit(_scan_segment, path, profile, scale, a, b, cancel, info.codec, hwaccel) for a, b in spans]
        cols = [f.result() for f in futs]
    return build_keywords(cols)


FPS_GRID = 1.0 / FPS
