"""Game aspect resolution for offline analysis: explicit aspect > video tag > auto-detection with the scene templates.

Videos imported from other machines carry no aditor_game_aspect tag, yet a 4:3/5:4/16:10 game stretched to 16:9 matches
nothing under the wrong layout. detect_aspect samples frames evenly over the video, classifies each with a SceneDetector per
supported aspect and keeps the aspect that recognises the most pre-match/lobby/HUD frames.
"""
from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path
from typing import Iterable, NamedTuple

import numpy as np

from . import ffbin
from .decode import build_input_args
from .errors import Cancelled
from .layout import SUPPORTED_ASPECTS, Layout, parse_aspect, tagged_layout
from .models import VideoInfo
from .scene import SCENE_SIZE, SceneDetector, SceneFrame

DETECT_SAMPLES = 40          # Frames sampled evenly over the video.
MIN_POSITIVE_FRAMES = 3      # A candidate needs at least this many positive frames; otherwise keep 16:9.
SAMPLE_TIMEOUT = 60.0        # Seconds allowed to extract one frame.
SAMPLE_RETRY_BACK = 1.0      # Seconds to step back when a sample position yields no frame.
DEFAULT_ASPECT = "16:9"
POSITIVE_KINDS = ("pre_match", "lobby", "in_match_hud")

# Per-aspect (positive frame count, summed template score).
AspectStats = dict[str, tuple[int, float]]


class Detection(NamedTuple):
    layout: Layout
    found: bool   # False when no aspect had enough positive frames and the default layout was kept.


def resolve_layout(explicit: Layout | None, info: VideoInfo) -> tuple[Layout | None, str]:
    """Explicit aspect > video tag, with the source name; (None, "default") means neither exists and the aspect must be detected."""
    if explicit is not None:
        return explicit, "explicit"
    tagged = tagged_layout(info.game_aspect)
    if tagged is not None:
        return tagged, "tag"
    return None, "default"


def _template_score(scene: SceneFrame) -> float:
    """How strongly the frame matched its best scene: the weakest of each scene's required templates, the strongest scene."""
    s = scene.scores
    if not s:
        return 0.0
    footer = max(s["loading_footer"], s["wildcard_footer"])
    minimap = max(s["minimap_border"], s["ranked_minimap"], s["spectator_minimap"], s["control_objectives"])
    health = max(s["health_border"], s["ranked_health"], s["spectator_health"])
    chevron = max(s["mode_chevron"], s["ranked_chevron"])
    return max(min(chevron, footer), min(s["ready_border"], s["mode_border"]), min(minimap, health))


def pick_aspect(stats: AspectStats) -> str | None:
    """Choose the aspect name with the most positive frames; None when none reaches MIN_POSITIVE_FRAMES.

    16:9 wins ties with the best count; ties among the other aspects go to the higher summed template score."""
    best = max((n for n, _ in stats.values()), default=0)
    if best < MIN_POSITIVE_FRAMES:
        return None
    if stats.get(DEFAULT_ASPECT, (0, 0.0))[0] == best:
        return DEFAULT_ASPECT
    return max((name for name, (n, _) in stats.items() if n == best), key=lambda name: stats[name][1])


def choose_layout(frames: Iterable[np.ndarray], scene_dir: Path | None = None) -> Detection:
    """Classify 640×360 grayscale frames with a SceneDetector per supported aspect and pick the best aspect."""
    detectors = {name: SceneDetector(scene_dir, layout=parse_aspect(name)) for name in SUPPORTED_ASPECTS}
    counts = {name: 0 for name in detectors}
    totals = {name: 0.0 for name in detectors}
    for frame in frames:
        for name, detector in detectors.items():
            scene = detector.classify(frame)
            counts[name] += scene.kind in POSITIVE_KINDS
            totals[name] += _template_score(scene)
    name = pick_aspect({n: (counts[n], totals[n]) for n in detectors})
    return Detection(Layout(1.0), False) if name is None else Detection(parse_aspect(name), True)


def _grab(path: str, t: float, hwaccel: bool, cancel: threading.Event | None = None) -> np.ndarray | None:
    """Decode one 640×360 grayscale frame at t; None when the video has no frame there."""
    w, h = SCENE_SIZE
    for hw in ((True, False) if hwaccel else (False,)):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        cmd = [ffbin.ffmpeg(), "-v", "error", "-nostdin"] + build_input_args(None, hw, t)
        cmd += ["-i", path, "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-vf", f"scale={w}:{h}",
                "-pix_fmt", "gray", "-threads", "1", "-f", "rawvideo", "pipe:1"]
        with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
            deadline = time.monotonic() + SAMPLE_TIMEOUT
            try:
                while True:
                    if cancel is not None and cancel.is_set():
                        raise Cancelled()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    try:
                        stdout, _ = proc.communicate(timeout=min(0.1, remaining))
                    except subprocess.TimeoutExpired:
                        continue
                    if cancel is not None and cancel.is_set():
                        raise Cancelled()
                    if proc.returncode == 0 and len(stdout) == w * h:
                        return np.frombuffer(stdout, np.uint8).reshape(h, w)
                    break
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.communicate()
    return None


def _sampled_frames(path: str, info: VideoInfo, hwaccel: bool, cancel: threading.Event | None):
    for i in range(DETECT_SAMPLES):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        t = info.duration * (i + 0.5) / DETECT_SAMPLES
        frame = _grab(path, t, hwaccel, cancel)
        if frame is None and t > SAMPLE_RETRY_BACK:  # Seeking past the last frame of a low-fps video yields nothing.
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            frame = _grab(path, t - SAMPLE_RETRY_BACK, hwaccel, cancel)
        if frame is not None:
            yield frame


def detect_aspect(path: str, info: VideoInfo, *, scene_dir: Path | None = None, hwaccel: bool = True,
                  cancel: threading.Event | None = None) -> Detection:
    """Sample about DETECT_SAMPLES frames evenly over the video and pick the aspect the scene templates recognise."""
    if info.duration <= 0:
        return Detection(Layout(1.0), False)
    return choose_layout(_sampled_frames(path, info, hwaccel, cancel), scene_dir=scene_dir)


def detect_layout(path: str, info: VideoInfo, *, hwaccel: bool = True,
                  cancel: threading.Event | None = None) -> Layout:
    """detect_aspect without the confidence flag: 16:9 when nothing is recognised."""
    return detect_aspect(path, info, hwaccel=hwaccel, cancel=cancel).layout
