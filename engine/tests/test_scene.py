"""Store only grayscale crops of required scene ROIs; restore their coordinates and test the full-frame entry point."""
import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from aditor.scene import SCENE_ROIS, SCENE_SIZE, SceneDetector

FIXTURES = Path(__file__).parent / "fixtures" / "matches"
SCREENS = json.loads((FIXTURES / "screens.json").read_text(encoding="utf-8"))


def load_screen(item):
    atlas = cv2.imdecode(np.fromfile(str(FIXTURES / item["file"]), np.uint8), cv2.IMREAD_GRAYSCALE)
    w, h = SCREENS["size"]
    frame = np.zeros((h, w), np.uint8)
    row = 0
    for _, x, y, rw, rh in SCREENS["rois"]:
        frame[y:y + rh, x:x + rw] = atlas[row:row + rh, :rw]
        row += rh
    return frame


@pytest.fixture(scope="module")
def detector():
    return SceneDetector()


@pytest.mark.parametrize("item", SCREENS["frames"], ids=lambda s: s["file"])
def test_scenes(detector, item):
    assert detector.classify(load_screen(item)).kind == item["scene"], item["evidence"]


@pytest.mark.parametrize("size", [(640, 360), (1280, 720), (1916, 1080), (2560, 1440)])
@pytest.mark.parametrize("kind", ["pre_match", "lobby", "in_match_hud", "other"])
def test_resolution_and_bgr(detector, size, kind):
    item = next(s for s in SCREENS["frames"] if s["scene"] == kind)
    gray = cv2.resize(load_screen(item), size)
    assert detector.classify(gray).kind == kind
    assert detector.classify(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)).kind == kind


def test_summary_is_positive_initial_match_context(detector):
    for filename in ("clip2_0000.png", "clip3_0006.png"):
        item = next(s for s in SCREENS["frames"] if s["file"] == filename)
        scene = detector.classify(load_screen(item))
        assert scene.kind == "other" and scene.match_context


@pytest.mark.parametrize("value", [0, 127, 255])
def test_flat_frames_are_other(detector, value):
    scene = detector.classify(np.full((360, 640), value, np.uint8))
    assert scene.kind == "other" and not scene.match_context
    assert scene.blank == (value == 0)
    assert all(np.isfinite(v) for v in scene.scores.values())


def test_dark_content_is_not_blank(detector):
    frame = np.zeros((360, 640), np.uint8)
    frame[100:110, 200:260] = 40
    assert not detector.classify(frame).blank


@pytest.mark.parametrize("frame", [np.zeros((180, 320), np.uint8),
                                   np.zeros((360, 640, 4), np.uint8),
                                   np.zeros((360, 640), np.float32)])
def test_unsupported_frames_fail_explicitly(detector, frame):
    with pytest.raises(ValueError):
        detector.classify(frame)


def test_roi_contract_and_fixture_budget():
    for _, x, y, w, h in SCREENS["rois"]:
        assert 0 <= x < x + w <= SCENE_SIZE[0]
        assert 0 <= y < y + h <= SCENE_SIZE[1]
    assert [(n, *(v // 3 for v in s["rect"])) for n, s in SCENE_ROIS.items()] == [
        tuple(r) for r in SCREENS["rois"]]
    assert sum(p.stat().st_size for p in FIXTURES.rglob("*.png")) < 2_000_000


def test_text_and_artwork_outside_masks_do_not_affect_opening(detector):
    item = next(s for s in SCREENS["frames"] if s["file"] == "clip1_0004.png")
    frame = load_screen(item)
    # Cover mode/map text and footer hints; preserve the slanted frame on the right and the gap in the panel.
    frame[20:85, :130] = 127
    frame[302:340, 200:460] = 255
    assert detector.classify(frame).kind == "pre_match"


def _stretch_4_3(frame):
    """Lay out the reference screen as a 4:3 game (640×480, each ROI kept at its anchor) and stretch it to 640×360."""
    canvas = np.zeros((480, 640), np.uint8)
    for roi in SCENE_ROIS.values():
        x, y, w, h = (v // 3 for v in roi["rect"])
        shift = {"top": 0, "center": 60, "bottom": 120}[roi["anchor"]]
        canvas[y + shift:y + shift + h, x:x + w] = frame[y:y + h, x:x + w]
    return cv2.resize(canvas, SCENE_SIZE, interpolation=cv2.INTER_AREA)


def test_scenes_of_a_stretched_4_3_game():
    """A 4:3 game keeps only 3/4 of the vertical resolution, so scores near a threshold may drop below it; such frames must
    fall back to other, never become a match, lobby, or opening that is not there."""
    from aditor.layout import parse_aspect
    detector = SceneDetector(layout=parse_aspect("4:3"))
    got = [(item["scene"], detector.classify(_stretch_4_3(load_screen(item))).kind) for item in SCREENS["frames"]]
    wrong = [(want, kind) for want, kind in got if want != kind]
    assert all(kind == "other" for _, kind in wrong), wrong
    assert len(wrong) <= len(got) // 20, wrong


def test_blank_uses_the_whole_frame_with_a_layout():
    from aditor.layout import parse_aspect
    frame = np.zeros((360, 640), np.uint8)
    frame[180, 320] = 255  # Outside every scene ROI.
    assert not SceneDetector(layout=parse_aspect("4:3")).classify(frame).blank
