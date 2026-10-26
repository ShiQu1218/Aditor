"""Recognise which supported game a video shows when it carries no aditor_game tag (imported videos).

Frames are sampled evenly over the video. Each is checked for Valorant's top scoreboard (valorant.scoreboard_visible) and
for Apex's pre-match/lobby/HUD scenes with the scene templates at every supported aspect (as aspect.py does). A game
needs at least MIN_POSITIVE_FRAMES; with neither, or a tie, the game is unknown and the caller asks the user.
"""
from __future__ import annotations

import subprocess
import threading
from pathlib import Path

import cv2
import numpy as np

from . import ffbin
from .aspect import MIN_POSITIVE_FRAMES, POSITIVE_KINDS, SAMPLE_RETRY_BACK, SAMPLE_TIMEOUT
from .decode import build_input_args
from .errors import Cancelled
from .layout import SUPPORTED_ASPECTS, parse_aspect
from .models import VideoInfo
from .scene import SCENE_SIZE, SceneDetector
from .valorant import scoreboard_visible

DETECT_SAMPLES = 24


class UnknownGame(ValueError):
    """The video shows neither supported game clearly enough; the user has to say which game it is."""


def _grab(path: str, t: float, hwaccel: bool) -> np.ndarray | None:
    """One BGR frame scaled to 1920x1080 at t, or None."""
    for hw in ((True, False) if hwaccel else (False,)):
        cmd = [ffbin.ffmpeg(), "-v", "error", "-nostdin"] + build_input_args(None, hw, t)
        cmd += ["-i", path, "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-vf", "scale=1920:1080",
                "-pix_fmt", "bgr24", "-threads", "1", "-f", "rawvideo", "pipe:1"]
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=SAMPLE_TIMEOUT).stdout
        except subprocess.TimeoutExpired:
            continue
        if len(out) == 1920 * 1080 * 3:
            return np.frombuffer(out, np.uint8).reshape(1080, 1920, 3)
    return None


def count_hits(frames, scene_dir: Path | None = None) -> dict[str, int]:
    """Positive frame counts per game for BGR 1920x1080 frames."""
    detectors = [SceneDetector(scene_dir, layout=parse_aspect(name)) for name in SUPPORTED_ASPECTS]
    hits = {"apex": 0, "valorant": 0}
    for frame in frames:
        if scoreboard_visible(frame):
            hits["valorant"] += 1
            continue
        gray = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), SCENE_SIZE, interpolation=cv2.INTER_AREA)
        if any(d.classify(gray).kind in POSITIVE_KINDS for d in detectors):
            hits["apex"] += 1
    return hits


def pick_game(hits: dict[str, int]) -> str | None:
    ranked = sorted(hits.items(), key=lambda kv: kv[1], reverse=True)
    (best, n), (_, runner_up) = ranked[0], ranked[1]
    return best if n >= MIN_POSITIVE_FRAMES and n > runner_up else None


def detect_game(path: str, info: VideoInfo, *, scene_dir: Path | None = None, hwaccel: bool = True,
                cancel: threading.Event | None = None) -> str | None:
    if info.duration <= 0:
        return None

    def frames():
        for i in range(DETECT_SAMPLES):
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            t = info.duration * (i + 0.5) / DETECT_SAMPLES
            frame = _grab(path, t, hwaccel)
            if frame is None and t > SAMPLE_RETRY_BACK:  # Seeking past the last frame of a low-fps video yields nothing.
                frame = _grab(path, t - SAMPLE_RETRY_BACK, hwaccel)
            if frame is not None:
                yield frame

    return pick_game(count_hits(frames(), scene_dir))
