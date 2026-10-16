"""每支影片的水平比例校準（spec §5.1）：處理拉伸解析度。"""
from __future__ import annotations

import threading

import numpy as np

from .decode import FPS, FrameStream
from .detect import Detector
from .errors import Cancelled
from .models import VideoInfo
from .profile import Profile

SCALES = [round(0.85 + 0.05 * i, 2) for i in range(7)]  # 0.85 … 1.15
WANTED_HITS = 5


def scan_scales(frames: list[np.ndarray], detector: Detector) -> float:
    """對 SCALES 各比例求所有 banner 的平均 best_scale_score，回傳最高者；無畫格回傳 1.0。"""
    if not frames:
        return 1.0
    means = [float(np.mean([detector.best_scale_score(f, s) for f in frames])) for s in SCALES]
    return SCALES[int(np.argmax(means))]


def _collect(path: str, profile: Profile, detector: Detector, start: float,
             budget: float, limit: float | None,
             cancel: threading.Event | None = None,
             codec: str | None = None) -> tuple[list[np.ndarray], float]:
    """從 start 解碼最多 budget 秒（且不超過時間 limit），回傳 (命中 banner, 實際掃描秒數)。"""
    hits: list[np.ndarray] = []
    scanned = 0.0
    stream = FrameStream(path, profile, start=start, codec=codec)
    try:
        for t, banner, spec in stream:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            if (limit is not None and t >= limit) or scanned >= budget:
                break
            scanned += 1.0 / FPS
            if detector.detect(banner, spec).kind is not None:
                hits.append(banner)
                if len(hits) >= WANTED_HITS:
                    break
    finally:
        stream.close()
    return hits, scanned


def calibrate(path: str, info: VideoInfo, profile: Profile, *,
              max_scan_seconds: float = 600.0,
              cancel: threading.Event | None = None) -> float:
    """從 duration/2 起解碼（到尾端後從 0 繼續，總計最多 max_scan_seconds），
    以 scale=1.0 收集命中畫格，再回傳最佳水平比例；一張都沒有則 1.0。"""
    detector = Detector(profile)
    mid = info.duration / 2
    hits, scanned = _collect(path, profile, detector, mid, max_scan_seconds, None, cancel,
                             info.codec)
    if len(hits) < WANTED_HITS and mid > 0 and scanned < max_scan_seconds:
        more, _ = _collect(path, profile, detector, 0.0, max_scan_seconds - scanned, mid, cancel,
                           info.codec)
        hits += more[:WANTED_HITS - len(hits)]
    return scan_scales(hits, detector)


def _collect_multi(path: str, profiles: list[Profile], detectors: list[Detector], start: float,
                   budget: float, limit: float | None,
                   hits: list[list[tuple[float, np.ndarray, str]]],
                   cancel: threading.Event | None = None,
                   codec: str | None = None) -> float:
    scanned = 0.0
    stream = FrameStream(path, profiles[0], start=start, codec=codec)
    try:
        for t, banner, spec in stream:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            if (limit is not None and t >= limit) or scanned >= budget:
                break
            scanned += 1.0 / FPS
            for i, det in enumerate(detectors):
                r = det.detect(banner, spec)
                if r.kind is not None:
                    hits[i].append((r.score, banner, r.kind))
            if any(_enough(h) for h in hits):
                break
    finally:
        stream.close()
    return scanned


# 自動語言偵測的「強」類型：這些類型沒有後備路徑，命中代表關鍵字範本真的對上了。
# assist_elim 在「助攻」後面找不到擊倒／消滅關鍵字時會當作後備結果，elim 也容易被不同語言的相似字形
# 偶然命中；簡體中文錄影（「助攻，击倒」）就是這樣被判成 zh-TW 卻只有極低召回（I5）。
STRONG_KINDS = frozenset({"knock", "assist_knock", "squad_wipe"})


def _strong(h) -> bool:
    return any(k in STRONG_KINDS for _, _, k in h)


def _enough(h) -> bool:
    return len(h) >= WANTED_HITS and _strong(h)


MIN_AUTO_HITS = 3  # 自動語言偵測：最佳語言至少要有這麼多命中畫格（約一個橫幅的下限），否則視為無法判斷


def calibrate_auto(path: str, info: VideoInfo, profiles: list[Profile], *,
                   max_scan_seconds: float = 600.0,
                   cancel: threading.Event | None = None) -> tuple[Profile | None, float]:
    """多語自動偵測與水平比例校準：回傳 (最佳語言 Profile, h_scale)。

    沒有任何語言達到 MIN_AUTO_HITS 命中、或命中全是弱類型（assist_elim／elim）時回傳 (None, 1.0)＝「無法判斷」，**絕不**悄悄退回某個語言。"""
    detectors = [Detector(p) for p in profiles]
    hits: list[list[tuple[float, np.ndarray, str]]] = [[] for _ in profiles]
    mid = info.duration / 2
    scanned = _collect_multi(path, profiles, detectors, mid, max_scan_seconds, None,
                             hits, cancel, info.codec)
    if not any(_enough(h) for h in hits) and mid > 0 and scanned < max_scan_seconds:
        _collect_multi(path, profiles, detectors, 0.0, max_scan_seconds - scanned, mid,
                       hits, cancel, info.codec)
    # 必須同時：命中格數夠多、且含至少一個「強」類型；否則視為無法判斷（lang_detected=false）
    ok = [i for i in range(len(profiles)) if len(hits[i]) >= MIN_AUTO_HITS and _strong(hits[i])]
    if not ok:
        return None, 1.0
    best_idx = max(ok, key=lambda i: (len(hits[i]), sum(s for s, _, _ in hits[i])))
    frames = [b for _, b, _ in hits[best_idx][:WANTED_HITS]]
    return profiles[best_idx], scan_scales(frames, detectors[best_idx])
