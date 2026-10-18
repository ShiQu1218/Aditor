"""串流對局切分與離線影片入口；事件時間以影片開頭為零。"""
from __future__ import annotations

import math
import subprocess
import tempfile
from contextlib import closing
from dataclasses import asdict, dataclass
from typing import Iterator

import numpy as np

from . import ffbin
from .decode import DecodeError, STDERR_LIMIT, build_input_args, is_gpu_path
from .probe import probe
from .scene import SCENE_SIZE, SceneDetector, SceneFrame

HUD_CONFIRM_SECONDS = 180.0
# 大廳連續出現這麼久就暫定結束（時間取大廳首次出現）；回大廳後常馬上開獎勵／組合包／商店，不能要求長時間停在大廳。
LOBBY_CONFIRM_SECONDS = 1.0  # 1 fps 下＝連續兩次取樣都是大廳
# 暫定結束後這段時間內沒有回到對局 HUD 才確定（大廳誤判時不會把一局切成兩段）。
LOBBY_SETTLE_SECONDS = 30.0
PRE_MATCH_REARM_SECONDS = 10.0
MAX_SAMPLE_GAP_FACTOR = 2.5


@dataclass(frozen=True)
class Match:
    start: float
    end: float


@dataclass(frozen=True)
class MatchEvent:
    type: str
    t: float
    reason: str


class MatchTracker:
    """feed 回傳本次確認的事件（時間可回溯）；finish 後由 matches 取得半開區間。"""

    def __init__(self, *, sample_period: float = 1.0):
        if not math.isfinite(sample_period) or sample_period <= 0:
            raise ValueError("取樣間隔必須為有限正數")
        self._max_gap = MAX_SAMPLE_GAP_FACTOR * sample_period
        self._first: float | None = None
        self._last: float | None = None
        self._active: float | None = None
        self._pending: float | None = None
        self._pre_last: float | None = None
        self._lobby_first: float | None = None
        self._end_pending: float | None = None
        self._recover_initial = True
        self._finished = False
        self._matches: list[Match] = []
        self._events: list[MatchEvent] = []

    @property
    def matches(self) -> list[Match]:
        return list(self._matches)

    @property
    def events(self) -> list[MatchEvent]:
        return list(self._events)

    def _start(self, t: float, reason: str) -> None:
        self._active = t
        self._events.append(MatchEvent("match_start", t, reason))

    def _end(self, t: float, reason: str) -> None:
        if self._active is not None:
            if t > self._active:
                self._matches.append(Match(self._active, t))
                self._events.append(MatchEvent("match_end", t, reason))
            self._active = None

    def _settle_lobby(self) -> None:
        if self._end_pending is not None:
            self._end(self._end_pending, "lobby")
            self._end_pending = None

    def feed(self, t: float, scene: SceneFrame) -> list[MatchEvent]:
        if self._finished:
            raise ValueError("對局串流已結束")
        if not math.isfinite(t) or t < 0 or (self._last is not None and t <= self._last):
            raise ValueError("影格時間必須為有限、非負且嚴格遞增")
        n = len(self._events)
        if self._first is None:
            self._first = t
        gap = self._last is not None and t - self._last > self._max_gap
        self._last = t
        if gap or scene.kind != "lobby":
            self._lobby_first = None
        if self._pending is not None and t - self._pending > HUD_CONFIRM_SECONDS:
            self._pending = None  # 開始事件尚未送出，取消時不用撤回已發事件。
        if self._end_pending is not None and t - self._end_pending >= LOBBY_SETTLE_SECONDS:
            self._settle_lobby()

        if scene.kind == "pre_match":
            new_sequence = self._pre_last is None or t - self._pre_last >= PRE_MATCH_REARM_SECONDS
            self._pre_last = t
            self._recover_initial = False
            if new_sequence and self._pending is None:
                if self._end_pending is not None:
                    self._settle_lobby()
                else:
                    self._end(t, "next_match")
                self._pending = t
        elif scene.kind == "lobby":
            self._recover_initial = False
            self._pending = None
            self._pre_last = None
            if self._lobby_first is None:
                self._lobby_first = t
            if (t - self._lobby_first >= LOBBY_CONFIRM_SECONDS and self._active is not None
                    and self._end_pending is None):
                self._end_pending = self._lobby_first
        elif scene.kind == "in_match_hud":
            self._end_pending = None  # 回到對局：先前的大廳是誤判或短暫畫面
            if self._pending is not None:
                self._start(self._pending, "opening_confirmed")
                self._pending = None
            elif self._active is None and self._recover_initial:
                self._start(self._first, "initial_match")
        elif scene.match_context and self._active is None and self._recover_initial:
            self._start(self._first, "initial_summary")
        return self._events[n:]

    def finish(self, end: float) -> list[MatchEvent]:
        if not math.isfinite(end) or end < (self._last or 0):
            raise ValueError("結束時間不可早於最後一格")
        if self._finished:
            return []
        n = len(self._events)
        if self._end_pending is not None:
            self._settle_lobby()
        self._end(end, "eof")
        self._pending = None
        self._finished = True
        return self._events[n:]


def _video_frames(path: str, fps: float, hwaccel: bool, codec: str) -> Iterator[tuple[float, np.ndarray]]:
    """沿用既有硬體選項與回退順序；stderr 寫暫存檔，避免管線阻塞／無界記憶體。"""
    w, h = SCENE_SIZE
    size = w * h
    plans = [(True, "nv12"), (True, "p010le"), (False, "nv12")] if hwaccel else [(False, "nv12")]
    k = 0
    for hw, fmt in plans:
        if fmt == "p010le" and (k or not is_gpu_path(codec, hw)):
            continue
        pre = f"fps={fps}:round=up"
        if is_gpu_path(codec, hw):
            pre += f",hwdownload,format={fmt}"
        cmd = [ffbin.ffmpeg(), "-v", "error", "-nostdin"]
        cmd += build_input_args(codec, hw, k / fps)
        cmd += ["-i", path, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf",
                f"{pre},scale={w}:{h}", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]
        with tempfile.TemporaryFile() as err:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, bufsize=0)
            try:
                buf = bytearray(size)
                view = memoryview(buf)
                while True:
                    got = 0
                    while got < size:
                        count = proc.stdout.readinto(view[got:])
                        if not count:
                            break
                        got += count
                    if got < size:
                        break
                    yield k / fps, np.frombuffer(buf, np.uint8).reshape(h, w).copy()
                    k += 1
                rc = proc.wait()
                if rc == 0 and got == 0:
                    return
                err.seek(0, 2)
                err.seek(max(0, err.tell() - STDERR_LIMIT))
                tail = err.read().decode("utf-8", errors="replace")
                if not hw:
                    raise DecodeError(f"場景解碼失敗（{rc}，影格位元組 {got}/{size}）", tail)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                proc.stdout.close()


def analyze_matches(path: str, *, fps: float = 1.0, timeline: bool = False,
                    hwaccel: bool = True) -> dict:
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("fps 必須為有限正數")
    info = probe(path)
    detector = SceneDetector()
    tracker = MatchTracker(sample_period=1 / fps)
    scenes = []
    with closing(_video_frames(path, fps, hwaccel, info.codec)) as frames:
        for t, frame in frames:
            if t >= info.duration:
                break
            scene = detector.classify(frame)
            tracker.feed(t, scene)
            if timeline:
                scenes.append([t, scene.kind])
    tracker.finish(info.duration)
    doc = {"matches": [asdict(m) for m in tracker.matches]}
    if timeline:
        doc["timeline"] = scenes
    return doc
