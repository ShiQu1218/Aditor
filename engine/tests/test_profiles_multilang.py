"""en／ja 範本與設定檔（載入、範本格式、多語載入）。偵測準確度見 test_detect_multilang（真實畫格）。"""
import cv2
import numpy as np
import pytest

from apexhl.profile import load_profile, resolve_profiles
from conftest import REPO


def _gray(path):
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_profile_loads_and_templates_are_binary_masks(lang):
    p = load_profile(REPO / "templates" / lang)
    assert p.lang == lang
    assert p.templates_version == f"{lang}@2"
    assert {"squad_wipe", "assist", "knock", "damage", "elim", "elim_done"} <= set(p.keywords)
    assert p.banner_roi == (560, 700, 800, 180)
    assert p.spec_roi == (60, 1028, 480, 40)
    assert p.line1_rows == (50, 108)  # 兩段英文、兩段日文實測第一行 y=64–81 都在帶內（見準確度報告）
    for spec in [*p.keywords.values(), *p.spec_templates]:
        t = _gray(p.dir / spec.file)
        assert set(np.unique(t)) <= {0, 255}, (lang, spec.file)
        assert 0.05 < (t > 0).mean() < 0.6, (lang, spec.file)
        ys, xs = np.nonzero(t)
        assert ys.min() >= 0 and xs.min() >= 0
        assert t.shape[0] - 1 - ys.max() <= 4 and t.shape[1] - 1 - xs.max() <= 4  # 緊貼筆畫（≤ 4 px 邊）


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_no_collage_or_duplicate_templates(lang):
    """沒有真實樣本的範本不得存在（曾有拼貼假範本），且不同 key 不得各存一份相同檔案內容。"""
    p = load_profile(REPO / "templates" / lang)
    assert "enemy_squad_down" not in p.keywords and not p.veto_supported
    files = [spec.file for spec in p.keywords.values()]
    blobs = {}
    for f in set(files):
        blobs.setdefault((p.dir / f).read_bytes(), []).append(f)
    assert all(len(v) == 1 for v in blobs.values()), blobs  # 相同內容只留一個檔、多個 key 共用


def test_ja_profile_declares_language_specifics():
    p = load_profile(REPO / "templates" / "ja")
    assert p.name_side == "left" and p.name_between_assist
    assert p.keywords["elim_done"].file == p.keywords["elim"].file  # を撃破（不含骷髏）；骷髏是獨立範本
    assert "skull" in p.keywords and p.spectating_supported and len(p.spec_templates) == 1


def test_resolve_profiles_single_and_auto():
    single = resolve_profiles(REPO / "templates" / "en")
    assert [p.lang for p in single] == ["en"]
    auto_root = resolve_profiles(REPO / "templates")
    assert [p.lang for p in auto_root] == ["zh-TW", "en", "ja"]
    auto_sub = resolve_profiles(REPO / "templates" / "auto")
    assert [p.lang for p in auto_sub] == ["zh-TW", "en", "ja"]
