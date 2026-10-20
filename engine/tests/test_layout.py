"""Game aspect ratio layout: HUD positions of 4:3/5:4/16:10 games stretched into the 16:9 reference frame."""
import numpy as np
import pytest

from aditor.layout import (CAPTURE_SPEC, SUPPORTED_ASPECTS, Layout, LayoutError, capture_rect, parse_aspect)
from aditor.scene import SCENE_ROIS, SCENE_SIZE


@pytest.mark.parametrize("text, squash", [("16:9", 1.0), ("16:10", 0.9), ("4:3", 0.75), ("5:4", 0.703125),
                                           ("1920x1440", 0.75), ("2560x1440", 1.0), ("1680x1050", 0.9)])
def test_parse_aspect(text, squash):
    assert parse_aspect(text).squash == pytest.approx(squash)


@pytest.mark.parametrize("text", ["", "4:", "0:3", "21:9", "3840x1600", "1:1", "x", "4:3:1", "-4:3"])
def test_parse_aspect_rejects_unsupported(text):
    with pytest.raises(LayoutError):
        parse_aspect(text)


@pytest.mark.parametrize("aspect", [
    pytest.param("9" * 5000 + ":1", id="excessive_integer"),
    pytest.param("9" * 400 + ":1", id="overflowing_ratio"),
])
def test_recorded_layout_ignores_invalid_numeric_tags(aspect):
    from aditor.layout import recorded_layout, tagged_layout
    assert recorded_layout(aspect) == Layout(1.0)
    assert tagged_layout(aspect) is None


@pytest.mark.parametrize("aspect", [None, "", "invalid", "21:9"])
def test_tagged_layout_is_none_for_missing_or_unsupported_tags(aspect):
    from aditor.layout import tagged_layout
    assert tagged_layout(aspect) is None


def test_tagged_layout_parses_supported_tags():
    from aditor.layout import tagged_layout
    assert tagged_layout("1920x1440") == Layout(0.75)


def test_source_rect_follows_anchor_after_vertical_squash():
    lay = Layout(0.75)
    assert lay.source_rect((21, 21, 309, 375), "top") == pytest.approx((21, 15.75, 309, 281.25))
    assert lay.source_rect((560, 700, 800, 180), "center") == pytest.approx((560, 660, 800, 135))
    assert lay.source_rect((99, 873, 366, 183), "bottom") == pytest.approx((99, 924.75, 366, 137.25))
    assert Layout(1.0).source_rect((560, 700, 800, 180), "center") == (560, 700, 800, 180)


def test_capture_rect_covers_every_supported_aspect():
    for name, (ref, anchor) in CAPTURE_SPEC.items():
        x, y, w, h = capture_rect(ref, anchor)
        assert 0 <= y and y + h <= 1080 and (x, w) == (ref[0], ref[2]), name
        for aspect in SUPPORTED_ASPECTS.values():
            sx, sy, sw, sh = Layout.from_ratio(aspect).source_rect(ref, anchor)
            assert y <= sy and sy + sh <= y + h, (name, aspect)


def test_extract_is_a_plain_crop_at_16_9():
    ref, anchor = CAPTURE_SPEC["banner"]
    x, y, w, h = capture_rect(ref, anchor)
    img = np.random.default_rng(0).integers(0, 255, (h, w, 3), np.uint8)
    out = Layout(1.0).extract(img, (x, y, w, h), ref, anchor)
    assert np.array_equal(out, img[ref[1] - y:ref[1] - y + ref[3]])


def test_extract_restores_squashed_content_to_reference_size():
    ref, anchor = CAPTURE_SPEC["banner"]
    cap = capture_rect(ref, anchor)
    lay = Layout(0.75)
    sx, sy, sw, sh = lay.source_rect(ref, anchor)
    img = np.zeros((cap[3], cap[2], 3), np.uint8)
    top = round(sy) - cap[1]
    img[top:top + round(sh)] = 200  # Squashed banner content.
    out = lay.extract(img, cap, ref, anchor)
    assert out.shape == (ref[3], ref[2], 3)
    assert out[2:-2].min() == 200


def test_reference_thumb_is_identity_at_16_9():
    thumb = np.random.default_rng(1).integers(0, 255, (SCENE_SIZE[1], SCENE_SIZE[0]), np.uint8)
    assert Layout(1.0).reference_thumb(thumb) is thumb


def test_reference_thumb_moves_each_scene_roi_by_its_anchor():
    lay = Layout(0.75)
    thumb = np.zeros((SCENE_SIZE[1], SCENE_SIZE[0]), np.uint8)
    roi = SCENE_ROIS["health"]
    sx, sy, sw, sh = (v / 3 for v in lay.source_rect(roi["rect"], roi["anchor"]))
    thumb[round(sy):round(sy + sh), round(sx):round(sx + sw)] = 255
    out = lay.reference_thumb(thumb)
    x, y, w, h = (v // 3 for v in roi["rect"])
    assert out.shape == thumb.shape
    assert out[y + 2:y + h - 2, x + 2:x + w - 2].min() == 255


def test_every_scene_roi_declares_an_anchor():
    assert {r["anchor"] for r in SCENE_ROIS.values()} <= {"top", "center", "bottom"}
