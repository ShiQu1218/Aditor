"""圖示偵測器（apexhl.icon_detect／apexhl.detect.Detector）：逐格行為、反例、名字指紋、觀戰。

fixture 是既有的 en／ja（訓練來源 English.mkv／Japanese.mkv）與 zh-TW（舊版遊戲）畫格；遮罩等價壓縮只保留
亮或紅的像素，圖示（白／灰）仍在，所以可以當回歸資料。zh-TW fixture 來自舊版本遊戲：加分圖示語意不同，
行為記錄成已知限制（見 test_old_season_*），不調參去貼合。"""
import json

import cv2
import numpy as np
import pytest

from apexhl.detect import Detector, PRODUCT_KINDS, same_name
from apexhl.icon_detect import ICON_NAMES, IconDetector, enemy_color_mask
from apexhl.models import FrameResult
from conftest import FIXTURES, ICON_DIR, LANGS, lang_labels, load_fixture


@pytest.fixture(scope="module")
def det(profile):
    return Detector(profile)


def _kind(det, lang, name):
    b, s = load_fixture(name, lang)
    return det.detect(b, s)


def test_icon_templates_are_small_pngs():
    total = 0
    for k in ICON_NAMES:
        f = ICON_DIR / f"{k}.png"
        assert f.exists(), k
        total += f.stat().st_size
        assert f.stat().st_size < 50_000
    assert total < 500_000


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_non_kill_banners_and_other_screens_are_never_product_events(det, lang):
    """REVIVE／CRATE REVEAL／EVO HARVESTER／BANNER RECOVERY／RESPAWN／RING SCAN、死亡結算、大廳、觀戰、
    HUD 等負例：同樣有加分箭頭的橫幅人形是三人 → 不是 knock／assist。"""
    bad = []
    for p in sorted((FIXTURES / lang / "neg").glob("*.png")):
        if _kind(det, lang, p.name).kind in PRODUCT_KINDS:
            bad.append(p.name)
    assert bad == []


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_squad_wipe_and_elim_are_never_product_events(det, lang):
    bad = []
    for p in sorted((FIXTURES / lang / "pos").glob("*.png")):
        if p.stem.startswith(("squad_wipe", "elim")) and _kind(det, lang, p.name).kind in PRODUCT_KINDS:
            bad.append(p.name)
    assert bad == []


@pytest.mark.parametrize("lang,prefix,expect,min_rate", [
    ("en", "knock_a", "knock", 0.85),
    ("ja", "knock_a", "knock", 0.80),
    ("en", "assist_knock_a", "assist_knock", 0.85),
    ("ja", "assist_knock_a", "assist_knock", 0.70),
    ("ja", "assist_elim_a", "assist_elim", 1.0),
])
def test_per_frame_rates_on_training_fixtures(det, lang, prefix, expect, min_rate):
    """非淡入正例的逐格命中率下限（淡入幀允許漏）。"""
    ps = sorted((FIXTURES / lang / "pos").glob(f"{prefix}*.png"))
    assert ps
    ok = sum(1 for p in ps if _kind(det, lang, p.name).kind == expect)
    assert ok / len(ps) >= min_rate, (ok, len(ps))


def test_knock_frames_carry_enemy_name_sig_and_damage_line(det):
    r = _kind(det, "en", "knock_a002500.png")
    assert r.kind == "knock" and r.damage_line and r.name_sig is not None and r.name_sig.width > 40
    r = _kind(det, "en", "assist_knock_a006500.png")
    assert r.kind == "assist_knock" and not r.damage_line and r.name_sig is None


def test_same_enemy_same_sig_different_enemy_different_sig(det, profile):
    en = {n: _kind(det, "en", n) for n in ("knock_a002400.png", "knock_a002500.png")}
    a, b = (r.name_sig for r in en.values())
    assert same_name(a, b, profile.name_sig_threshold)
    other = [_kind(det, "en", p.name).name_sig for p in sorted((FIXTURES / "en" / "pos").glob("knock_a02[0-9]*.png"))[:1]]
    assert all(o is None or not same_name(a, o, profile.name_sig_threshold) for o in other)


def test_pink_and_yellow_name_colours_are_enemy_colours():
    px = np.array([[[40, 40, 220], [59, 171, 180], [163, 152, 220], [200, 200, 200]]], np.uint8)  # BGR：紅、黃、粉紅、白
    assert enemy_color_mask(px)[0].tolist() == [True, True, True, False]


def test_banner_roi_excludes_top_right_kill_counter(profile):
    """右上角擊殺數／小隊存活不在 banner_roi 內，結構上不可能誤報。"""
    x, y, w, h = profile.banner_roi
    assert y > 540 and x + w < 1920 - 400 and y + h < 1080


# ---- 舊版遊戲（zh-TW fixture）上的行為：文件化的已知限制 ----

def test_old_season_behaviour_is_documented_not_tuned(det):
    """舊版（2026-07）遊戲：「敵方小隊已消滅」「小隊抹殺」「造訪過的興趣點」用單人加分圖示，
    圖示法無法與擊倒／助攻擊倒區分（需要文字或分數數字）→ 這些會被誤判成 knock／assist_knock。
    其餘（擊倒、助攻擊倒、助攻消滅、獨立消滅、其他畫面、觀戰）行為與新版相同。
    下列數字是目前行為的凍結值，若偵測器改動使它們變動，請同步更新並在準確度報告記錄。"""
    lab = lang_labels("zh-TW")
    assert len(lab) == 86
    got = {}
    for n, v in lab.items():
        r = _kind(det, "zh-TW", n)
        key = (v["kind"], bool(v.get("fadein")), r.kind)
        got[key] = got.get(key, 0) + 1
    ok = lambda k: sum(c for (kind, fade, res), c in got.items() if kind == k and not fade and res == k)  # noqa: E731
    assert ok("knock") == 7 and ok("assist_knock") == 6 and ok("assist_elim") == 6
    assert got.get(("elim", False, None)) == 9            # 獨立消滅不誤報
    # 已知限制：舊版小隊抹殺 6 張 → 全部誤判為單人加分橫幅；其他負例 8 張誤報（敵方小隊已消滅 7＋興趣點 1）
    assert got.get(("squad_wipe", False, "knock"), 0) + got.get(("squad_wipe", False, "assist_knock"), 0) == 6
    assert got.get((None, False, "knock"), 0) + got.get((None, False, "assist_knock"), 0) == 8


@pytest.mark.xfail(strict=True, reason="舊版本遊戲的「敵方小隊已消滅 +50」也用單人加分圖示，"
                                      "圖示法無法與助攻擊倒區分；已知限制，不調參去貼合")
def test_old_season_enemy_squad_down_is_rejected(det):
    for p in sorted((FIXTURES / "zh-TW" / "neg").glob("enemy_squad_down_*.png")):
        assert _kind(det, "zh-TW", p.name).kind not in PRODUCT_KINDS, p.name


# ---- 觀戰（唯一與語言有關的樣板：三語言並列、任一命中即算） ----

@pytest.mark.parametrize("lang", LANGS)
def test_spectating_detected_in_every_language_without_choosing_one(det, lang):
    """三語言所有 fixture：觀戰畫格全部命中、非觀戰畫格全部不命中
    （跨語言誤判量測：五個樣板對另外兩個語言共 ~200 張非觀戰畫格 0 次誤報）。"""
    wrong = []
    for n, v in lang_labels(lang).items():
        _, spec = load_fixture(n, lang)
        if det._spectating(spec) != bool(v["spectating"]):
            wrong.append(n)
    assert wrong == []


def test_synthetic_frame_result_defaults():
    r = FrameResult("knock", 0.9, 0, False, None, False)
    assert r.hint is None


def test_single_off_one_scale_detector_never_raises_on_empty_or_unmatched_frames(profile):
    """校準得到 0.95 等非 1.0 尺度時，沒有任何命中的畫格（空白、比樣板小的帶）也不得因預設尺度而出錯。"""
    d = Detector(profile, icon_scale=0.95)
    blank = np.zeros((180, 800, 3), np.uint8)
    spec = np.zeros((40, 480, 3), np.uint8)
    assert d.detect(blank, spec).kind is None
    assert IconDetector(ICON_DIR, scales=(1.1,)).features(np.zeros((40, 800, 3), np.uint8)).kind is None


@pytest.mark.parametrize("scale", [0.9, 0.95, 1.0, 1.05, 1.1])
def test_every_calibration_scale_is_a_valid_detector_scale(profile, scale):
    r = Detector(profile, icon_scale=scale).detect(*load_fixture("knock_a002500.png", "en"))
    assert r.kind in ("knock", None)
