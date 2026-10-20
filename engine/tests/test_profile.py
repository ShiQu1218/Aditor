"""Load and validate templates/icons/profile.json, a single language-independent profile."""
import json
import shutil

import pytest

from aditor.icon_detect import ICON_NAMES, enemy_color_mask
from aditor.profile import ProfileError, load_profile
from conftest import ICON_DIR


def _copy(tmp_path, mutate=None):
    d = tmp_path / "p"
    shutil.copytree(ICON_DIR, d)
    doc = json.loads((d / "profile.json").read_text(encoding="utf-8"))
    if mutate:
        mutate(doc)
    (d / "profile.json").write_text(json.dumps(doc), encoding="utf-8")
    return d


def test_shipped_profile_loads():
    p = load_profile(ICON_DIR)
    assert p.templates_version.startswith("icons@")
    assert p.banner_roi == (560, 700, 800, 180) and p.dedupe_window == 90
    assert not hasattr(p, "lang") and not hasattr(p, "keywords")


def test_shipped_templates_exist_and_are_small():
    total = 0
    for k in ICON_NAMES:
        f = ICON_DIR / f"{k}.png"
        assert f.exists(), k
        total += f.stat().st_size
    p = load_profile(ICON_DIR)
    for s in p.spectating:
        total += (ICON_DIR / s.file).stat().st_size
    assert total < 100_000


def test_spectating_templates_cover_the_three_shipped_languages():
    names = {s.file for s in load_profile(ICON_DIR).spectating}
    assert {"spec_zh-TW_show_flag.png", "spec_en_show_flag.png", "spec_ja_show_flag.png"} <= names


def test_profile_yellow_pink_rules_match_icon_detector_mask():
    """Yellow/pink name-signature rules use the same values as the icon detector's enemy_color_mask.
    The red rule is intentionally wider: signatures should capture full glyphs, while icon cues only need to detect enemy color."""
    import numpy as np
    from aditor.detect import red_mask
    p = load_profile(ICON_DIR)
    rng = np.random.default_rng(0)
    px = rng.integers(0, 256, (1, 20000, 3), dtype=np.uint8)
    wide = red_mask(px, p, pink=True) > 0
    assert (wide | enemy_color_mask(px) == wide).all()  # The signature mask covers the icon-cue mask.


def test_missing_spectating_template_file(tmp_path):
    d = _copy(tmp_path)
    (d / "spec_en_show_flag.png").unlink()
    with pytest.raises(ProfileError, match="spec_en_show_flag.png"):
        load_profile(d)


@pytest.mark.parametrize("name", ICON_NAMES)
def test_missing_icon_template_file(tmp_path, name):
    d = _copy(tmp_path)
    (d / f"{name}.png").unlink()
    with pytest.raises(ProfileError, match=f"{name}.png"):
        load_profile(d)


def test_undecodable_icon_template_raises_clear_error(tmp_path):
    from aditor.icon_detect import IconDetector
    d = _copy(tmp_path)
    (d / "chev.png").write_bytes(b"not a png")
    with pytest.raises(ValueError, match="chev.png"):
        IconDetector(d)


def test_missing_profile_and_bad_json(tmp_path):
    with pytest.raises(ProfileError):
        load_profile(tmp_path)
    (tmp_path / "profile.json").write_text("{bad", encoding="utf-8")
    with pytest.raises(ProfileError):
        load_profile(tmp_path)


@pytest.mark.parametrize("key", ["templates_version", "banner_roi", "spec_roi", "white", "red",
                                 "spectating", "name_sig_threshold", "dedupe_window"])
def test_required_key_missing(tmp_path, key):
    with pytest.raises(ProfileError, match=key):
        load_profile(_copy(tmp_path, lambda d: d.pop(key)))


@pytest.mark.parametrize("mutate,match", [
    (lambda d: d.update(banner_roi=[1, 2, 3]), "banner_roi"),
    (lambda d: d.update(banner_roi=[0, 0, 0, 180]), "banner_roi"),
    (lambda d: d["white"].pop("v_min"), "v_min"),
    (lambda d: d["red"].pop("r_min"), "r_min"),
    (lambda d: d.update(name_sig_threshold=0), "name_sig_threshold"),
    (lambda d: d.update(dedupe_window=-1), "dedupe_window"),
    (lambda d: d.update(templates_version=""), "templates_version"),
    (lambda d: d.update(spectating={}), "spectating"),
    (lambda d: d["spectating"][0].update(threshold=1.5), "threshold"),
    (lambda d: d["spectating"][0].pop("file"), "file"),
    (lambda d: d["spectating"][0].update(file="../profile.json"), "file"),
    (lambda d: d["red"]["yellow"].pop("rg_max"), "red.yellow.rg_max"),
    (lambda d: d["red"].update(pink="x"), "red.pink"),
    (lambda d: d["red"]["pink"].update(bg_min="a"), "red.pink.bg_min"),
])
def test_invalid_field_rejected(tmp_path, mutate, match):
    with pytest.raises(ProfileError, match=match):
        load_profile(_copy(tmp_path, mutate))


def test_spectating_may_be_empty(tmp_path):
    p = load_profile(_copy(tmp_path, lambda d: d.update(spectating=[])))
    assert p.spectating == []


def test_shipped_capture_rois_cover_every_supported_aspect():
    """The app passes capture_rois to aditorrec; they must equal the engine's union of all supported game aspects."""
    from aditor.layout import BANNER_ANCHOR, SPEC_ANCHOR, capture_rect
    doc = json.loads((ICON_DIR / "profile.json").read_text(encoding="utf-8"))
    p = load_profile(ICON_DIR)
    assert tuple(doc["capture_rois"]["banner"]) == capture_rect(p.banner_roi, BANNER_ANCHOR) == p.capture_banner
    assert tuple(doc["capture_rois"]["spec"]) == capture_rect(p.spec_roi, SPEC_ANCHOR) == p.capture_spec


def test_profile_layout_defaults_to_16_9_and_can_be_replaced():
    from aditor.layout import parse_aspect
    p = load_profile(ICON_DIR)
    assert p.layout.identity
    q = p.with_layout(parse_aspect("4:3"))
    assert q.layout.squash == 0.75 and p.layout.identity and q.banner_roi == p.banner_roi
