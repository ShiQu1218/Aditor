"""只保存必要場景 ROI 的灰階拼圖；還原座標後測試同一個全畫面入口。"""
import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from apexhl.scene import SCENE_ROIS, SCENE_SIZE, SceneDetector

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
    assert all(np.isfinite(v) for v in scene.scores.values())


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
    # 蓋掉模式／地圖文字、底部提示文字；保留右側斜框與底板缺口。
    frame[20:85, :130] = 127
    frame[302:340, 200:460] = 255
    assert detector.classify(frame).kind == "pre_match"
