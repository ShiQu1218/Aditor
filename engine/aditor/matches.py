"""Streaming match segmentation and offline video entry point; event times are relative to the start of the video."""
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
# If the opening sequence was missed, the in-match HUD must persist this long to restore the match start.
HUD_RESUME_CONFIRM_SECONDS = 3.0
# Keep within the app's 15 s prune buffer minus its 5 s pre-pad.
INITIAL_RECOVERY_SECONDS = 10.0
# A lobby visible continuously for this long tentatively ends the match (using the first lobby timestamp).
# Rewards, bundles, or the store often appear soon after returning to the lobby, so do not require a long lobby dwell.
LOBBY_CONFIRM_SECONDS = 1.0  # At 1 fps, two consecutive samples must show the lobby.
# Confirm the tentative end only if the in-match HUD does not return within this interval (avoids splitting a match after a lobby false positive).
LOBBY_SETTLE_SECONDS = 30.0
PRE_MATCH_REARM_SECONDS = 10.0
# A fully black frame during a match (DDA: game not in foreground) persisting this long means the player left the match;
# use the start of the black interval as the end time. If the player switches away after a match and returns only for
# the next drop, the lobby and opening sequence are not captured, so this is the only way to split matches. The time
# between death and the next drop is usually much longer than this, while a brief app switch will not split a match.
BLANK_END_SECONDS = 60.0
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
    """feed returns events confirmed by this sample (timestamps may move backward); call matches after finish to get half-open intervals."""

    def __init__(self, *, sample_period: float = 1.0):
        if not math.isfinite(sample_period) or sample_period <= 0:
            raise ValueError("Sampling interval must be a finite positive number")
        self._max_gap = MAX_SAMPLE_GAP_FACTOR * sample_period
        self._first: float | None = None
        self._last: float | None = None
        self._active: float | None = None
        self._pending: float | None = None
        self._pre_last: float | None = None
        self._hud_first: float | None = None
        self._lobby_first: float | None = None
        self._blank_first: float | None = None
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
        self._hud_first = None
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
            raise ValueError("Match stream has ended")
        if not math.isfinite(t) or t < 0 or (self._last is not None and t <= self._last):
            raise ValueError("Frame timestamps must be finite, non-negative, and strictly increasing")
        n = len(self._events)
        if self._first is None:
            self._first = t
        if t - self._first > INITIAL_RECOVERY_SECONDS:
            self._recover_initial = False
        gap = self._last is not None and t - self._last > self._max_gap
        self._last = t
        if gap or scene.kind != "lobby":
            self._lobby_first = None
        if gap or scene.kind != "in_match_hud":
            self._hud_first = None
        if gap or not scene.blank:
            self._blank_first = None
        if self._pending is not None and t - self._pending > HUD_CONFIRM_SECONDS:
            self._events.append(MatchEvent("match_cancel", t, "timeout"))
            self._pending = None
        if self._end_pending is not None and t - self._end_pending >= LOBBY_SETTLE_SECONDS:
            self._settle_lobby()
        if scene.blank:
            if self._blank_first is None:
                self._blank_first = t
            if t - self._blank_first >= BLANK_END_SECONDS:
                # If a lobby was already seen, use it as the boundary; a later HUD return must be reconfirmed and must not rewind to the recording start.
                self._settle_lobby()
                self._end(self._blank_first, "hidden")
                self._recover_initial = False

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
                self._events.append(MatchEvent("match_pending", t, "pre_match"))
        elif scene.kind == "lobby":
            self._recover_initial = False
            if self._pending is not None:
                self._events.append(MatchEvent("match_cancel", t, "lobby"))
            self._pending = None
            self._pre_last = None
            if self._lobby_first is None:
                self._lobby_first = t
            if (t - self._lobby_first >= LOBBY_CONFIRM_SECONDS and self._active is not None
                    and self._end_pending is None):
                self._end_pending = self._lobby_first
        elif scene.kind == "in_match_hud":
            self._end_pending = None  # Back in the match: the prior lobby was a false positive or a transient frame.
            if self._pending is not None:
                self._start(self._pending, "opening_confirmed")
                self._pending = None
            elif self._active is None and self._recover_initial:
                self._start(self._first, "initial_match")
            elif self._active is None:
                if self._hud_first is None:
                    self._hud_first = t
                if t - self._hud_first >= HUD_RESUME_CONFIRM_SECONDS:
                    self._start(self._hud_first, "hud_resume")
        elif scene.match_context and self._active is None and self._recover_initial:
            self._start(self._first, "initial_summary")
        return self._events[n:]

    def finish(self, end: float) -> list[MatchEvent]:
        if not math.isfinite(end) or end < (self._last or 0):
            raise ValueError("End time cannot precede the last frame")
        if self._finished:
            return []
        n = len(self._events)
        if self._end_pending is not None:
            self._settle_lobby()
        self._end(end, "eof")
        if self._pending is not None:
            self._events.append(MatchEvent("match_cancel", end, "eof"))
        self._pending = None
        self._finished = True
        return self._events[n:]


def _video_frames(path: str, fps: float, hwaccel: bool, codec: str) -> Iterator[tuple[float, np.ndarray]]:
    """Reuse the existing hardware options and fallback order; write stderr to a temporary file to avoid pipe blocking and unbounded memory use."""
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
                    raise DecodeError(f"Scene decoding failed ({rc}, frame bytes {got}/{size})", tail)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                proc.stdout.close()


def analyze_matches(path: str, *, fps: float = 1.0, timeline: bool = False,
                    hwaccel: bool = True) -> dict:
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("fps must be a finite positive number")
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
