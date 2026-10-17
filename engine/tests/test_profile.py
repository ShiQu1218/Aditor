"""templates/icons/profile.json 載入與驗證（單一、與語言無關的設定檔）。"""
import json
import shutil

import pytest

from apexhl.icon_detect import ICON_NAMES, enemy_color_mask
from apexhl.profile import ProfileError, load_profile
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
    """名字指紋的黃／粉紅規則與圖示偵測的 enemy_color_mask 是同一組數值（紅規則刻意較寬：
    指紋要盡量讀到完整字形；圖示線索只需要有無敵人色）。"""
    import numpy as np
    from apexhl.detect import red_mask
    p = load_profile(ICON_DIR)
    rng = np.random.default_rng(0)
    px = rng.integers(0, 256, (1, 20000, 3), dtype=np.uint8)
    wide = red_mask(px, p, pink=True) > 0
    assert (wide | enemy_color_mask(px) == wide).all()  # 指紋遮罩涵蓋圖示線索遮罩


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
    from apexhl.icon_detect import IconDetector
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
