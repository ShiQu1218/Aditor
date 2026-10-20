"""Auto-detect the game aspect of untagged videos with the scene templates."""
import subprocess

import cv2
import numpy as np
import pytest

from aditor import aspect as asp
from aditor import ffbin
from aditor.aspect import (DETECT_SAMPLES, MIN_POSITIVE_FRAMES, choose_layout, detect_aspect, detect_layout,
                           pick_aspect)
from aditor.layout import SUPPORTED_ASPECTS, Layout, parse_aspect
from aditor.probe import probe
from aditor.scene import SCENE_ROIS, SCENE_SIZE
from conftest import make_video
from test_scene import SCREENS, load_screen


def _positive_screens():
    return [load_screen(s) for s in SCREENS["frames"] if s["scene"] in ("in_match_hud", "lobby")]


def _stretch(frame, name):
    """Lay the reference screen out as a game of the given aspect (640 wide, ROIs kept at their anchors) and stretch it to 640×360."""
    if name == "16:9":
        return frame
    height = round(SCENE_SIZE[0] / SUPPORTED_ASPECTS[name])
    canvas = np.zeros((height, SCENE_SIZE[0]), np.uint8)
    spare = height - SCENE_SIZE[1]
    for roi in SCENE_ROIS.values():
        x, y, w, h = (v // 3 for v in roi["rect"])
        shift = {"top": 0, "center": spare // 2, "bottom": spare}[roi["anchor"]]
        canvas[y + shift:y + shift + h, x:x + w] = frame[y:y + h, x:x + w]
    return cv2.resize(canvas, SCENE_SIZE, interpolation=cv2.INTER_AREA)


def _encode(tmp_path, name, frames):
    """Encode grayscale 640×360 frames as a 1 fps 1280×720 H.264 video."""
    out = tmp_path / name
    cmd = [ffbin.ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "640x360", "-r", "1",
           "-i", "-", "-vf", "scale=1280:720", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(out)]
    r = subprocess.run(cmd, input=b"".join(np.ascontiguousarray(f).tobytes() for f in frames), capture_output=True)
    assert r.returncode == 0, r.stderr.decode(errors="replace")
    return out


def _mixed(name, count=DETECT_SAMPLES):
    """Positive screens interleaved with flat frames, as a game video that is not all HUD."""
    pos = _positive_screens()
    return [_stretch(pos[i % len(pos)], name) if i % 3 else np.full((360, 640), 90, np.uint8) for i in range(count)]


def test_pick_aspect_needs_a_minimum_of_positive_frames():
    assert pick_aspect({"16:9": (0, 0.0), "4:3": (MIN_POSITIVE_FRAMES - 1, 9.0)}) is None
    assert pick_aspect({"16:9": (0, 0.0), "4:3": (MIN_POSITIVE_FRAMES, 1.0)}) == "4:3"


def test_pick_aspect_prefers_16_9_on_a_tie_and_the_best_count_otherwise():
    assert pick_aspect({"16:9": (5, 1.0), "4:3": (5, 9.0)}) == "16:9"
    assert pick_aspect({"16:9": (4, 9.0), "4:3": (5, 1.0)}) == "4:3"
    assert pick_aspect({"16:9": (9, 1.0), "4:3": (5, 9.0)}) == "16:9"


def test_pick_aspect_breaks_non_16_9_ties_by_template_scores():
    stats = {"16:9": (0, 0.0), "4:3": (6, 3.0), "5:4": (6, 4.5), "16:10": (5, 9.0)}
    assert pick_aspect(stats) == "5:4"


@pytest.mark.parametrize("name", list(SUPPORTED_ASPECTS))
def test_choose_layout_on_injected_frames(name):
    det = choose_layout(_stretch(f, name) for f in _positive_screens())
    assert det.found and det.layout == parse_aspect(name)


def test_choose_layout_without_positive_frames_is_default():
    det = choose_layout([np.full((360, 640), 90, np.uint8)] * 20 + [np.zeros((360, 640), np.uint8)] * 20)
    assert not det.found and det.layout == Layout(1.0)


def test_choose_layout_ignores_a_few_stray_positive_frames():
    pos = _positive_screens()
    frames = [np.full((360, 640), 90, np.uint8)] * 30 + [_stretch(pos[0], "4:3")] * (MIN_POSITIVE_FRAMES - 1)
    assert not choose_layout(frames).found


@pytest.mark.parametrize("name", list(SUPPORTED_ASPECTS))
def test_detect_layout_from_encoded_video(tmp_path, name):
    v = _encode(tmp_path, "game.mp4", _mixed(name))
    info = probe(str(v))
    det = detect_aspect(str(v), info, hwaccel=False)
    assert det.found and det.layout == parse_aspect(name)
    assert detect_layout(str(v), info, hwaccel=False) == parse_aspect(name)


def test_detect_layout_samples_the_whole_video(tmp_path, monkeypatch):
    v = _encode(tmp_path, "game.mp4", _mixed("4:3", 60))
    seen = []
    real = asp.choose_layout
    monkeypatch.setattr(asp, "choose_layout", lambda frames: real(seen.append(f) or f for f in frames))
    detect_aspect(str(v), probe(str(v)), hwaccel=False)
    assert len(seen) == DETECT_SAMPLES


def test_detect_layout_of_a_plain_video_is_16_9(tmp_path):
    v = make_video(tmp_path, "plain.mp4", 6)
    det = detect_aspect(str(v), probe(str(v)), hwaccel=True)
    assert not det.found and det.layout == Layout(1.0)


def test_detect_layout_honours_cancel(tmp_path):
    import threading
    from aditor.errors import Cancelled
    v = make_video(tmp_path, "plain.mp4", 3)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        detect_layout(str(v), probe(str(v)), hwaccel=False, cancel=cancel)
