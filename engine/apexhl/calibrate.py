"""每支影片的圖示尺度校準（spec §5.1）：處理 HUD 縮放與非 1080p 錄影。

圖示樣板取自 1080p、HUD 100%；其他 HUD 縮放下圖示大小不同。校準一次：找到幾個有加分橫幅的畫格
（箭頭＋「+」號），在 DEFAULT_SCALES 各尺度比對，取最佳尺度的中位數；之後整支影片只用這一個尺度（速度）。"""
from __future__ import annotations

import threading

import numpy as np

from .decode import FPS, FrameStream
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
