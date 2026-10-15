"""單格偵測：真實畫格 fixture（tests/fixtures/zh-TW）與合成資料。"""
import time

import numpy as np
import pytest

from apexhl.detect import Detector, name_sig_similarity, red_mask, white_mask
from apexhl.models import FrameResult
from conftest import load_fixture

# 各類型畫面上「合法同時出現」的關鍵字；其餘關鍵字都應明顯低於勝出的關鍵字
_COMPANIONS = {
    "knock": {"knock", "damage"},
    "assist_knock": {"assist", "knock"},
    "assist_elim": {"assist", "elim"},
    "elim": {"elim_done", "elim"},
    "squad_wipe": {"squad_wipe"},
}
_WINNER = {"knock": "knock", "assist_knock": "assist", "assist_elim": "assist",
           "elim": "elim_done", "squad_wipe": "squad_wipe"}
# 實測最小值（見 task-4-report）：主關鍵字領先 0.287、助攻後 knock/elim 之間領先 0.519，取保守下界
_MIN_MARGIN = 0.25
_MIN_SUB_MARGIN = 0.45


def test_positive_fixtures(zh_detector, labeled):
    items = labeled(kind_not_null=True, exclude_fadein=True)
    assert len(items) >= 30
    for name, lab in items:
        r = zh_detector.detect(*load_fixture(name))
        assert r.kind == lab["kind"], name
        assert r.damage_line == lab["damage_line"], name


def test_negative_fixtures(zh_detector, labeled):
    items = labeled(kind_null=True)
    assert len(items) >= 40
    for name, lab in items:
        assert zh_detector.detect(*load_fixture(name)).kind is None, name


def test_enemy_squad_down_is_vetoed(zh_detector, labeled):
    items = [(n, lab) for n, lab in labeled(kind_null=True) if lab.get("tag") == "enemy_squad_down"]
    assert len(items) >= 5
    for name, _ in items:
        banner, spec = load_fixture(name)
        assert zh_detector.keyword_scores(banner)["elim_done"] > 0.5, name  # 含「已消滅」，確實需要否決
        assert zh_detector.detect(banner, spec).kind is None, name


def test_fadein_frames_may_be_missed(zh_detector, labeled):
    """淡入第一格字體放大且半透明（spec §3），允許漏判，但不得誤判成別的類型。"""
    items = [(n, lab) for n, lab in labeled(kind_not_null=True) if lab.get("fadein")]
    assert items
    for name, lab in items:
        assert zh_detector.detect(*load_fixture(name)).kind in (None, lab["kind"]), name


def test_spectating_fixtures(zh_detector, labeled):
    items = labeled()
    assert any(lab["spectating"] for _, lab in items)
    for name, lab in items:
        assert zh_detector.detect(*load_fixture(name)).spectating == lab["spectating"], name


def test_assist_not_confused_with_knock(zh_detector, labeled):
    items = labeled(kind="assist_knock", exclude_fadein=True)
    assert len(items) >= 5
    for name, _ in items:
        assert zh_detector.detect(*load_fixture(name)).kind == "assist_knock", name


def test_assist_elim_not_confused(zh_detector, labeled):
    items = labeled(kind="assist_elim")
    assert len(items) >= 5
    for name, _ in items:
        assert zh_detector.detect(*load_fixture(name)).kind == "assist_elim", name


def test_keyword_distinctness_margin(zh_detector, labeled):
    """每張正例：勝出關鍵字領先所有『不該出現』的關鍵字至少 _MIN_MARGIN。"""
    for name, lab in labeled(kind_not_null=True, exclude_fadein=True):
        banner, _ = load_fixture(name)
        sc = zh_detector.keyword_scores(banner)
        kind = lab["kind"]
        others = max(v for k, v in sc.items() if k not in _COMPANIONS[kind])
        assert sc[_WINNER[kind]] - others >= _MIN_MARGIN, (name, sc)
        if kind == "assist_knock":
            assert sc["knock"] - sc["elim"] >= _MIN_SUB_MARGIN, (name, sc)
        if kind == "assist_elim":
            assert sc["elim"] - sc["knock"] >= _MIN_SUB_MARGIN, (name, sc)


def _sig(det, name):
    return det.detect(*load_fixture(name)).name_sig


def _similar(det, prof, a, b):
    sa, sb = _sig(det, a), _sig(det, b)
    assert sa is not None and sb is not None, (a, b)
    ratio = abs(sa.width - sb.width) / max(sa.width, sb.width)
    return name_sig_similarity(sa, sb) >= prof.name_sig_threshold and ratio < 0.15


# 同一敵人（「我回来了孩子们」，來源 17-17-13）的紅字（擊倒／已消滅）× 白字（助攻）跨顏色配對
_CROSS_COLOR_PAIRS = [
    ("knock_a005000.png", "assist_knock_a007150.png"),
    ("knock_a005000.png", "assist_elim_a007400.png"),
    ("elim_a005375.png", "assist_knock_a007150.png"),
    ("elim_a005375.png", "assist_elim_a007400.png"),
]


@pytest.mark.parametrize("a,b", _CROSS_COLOR_PAIRS)
def test_name_sig_same_enemy_across_colors(zh_detector, zh_profile, a, b):
    assert _similar(zh_detector, zh_profile, a, b), (a, b)


def test_name_sig_same_enemy_same_type(zh_detector, zh_profile):
    # DEWYANE：兩格相鄰的擊倒、不同影片的已消滅 × 擊倒
    assert _similar(zh_detector, zh_profile, "knock_b073650.png", "knock_b073750.png")
    assert _similar(zh_detector, zh_profile, "elim_a058000.png", "knock_b073650.png")


@pytest.mark.xfail(strict=True, reason="已知限制：白字名（助攻，消滅）右側有亮背景雜線時指紋寬度被拉長")
def test_name_sig_known_noisy_pair(zh_detector, zh_profile):
    assert _similar(zh_detector, zh_profile, "assist_elim_b009250.png", "elim_b027375.png")


def test_name_sig_different_enemies_are_dissimilar(zh_detector, zh_profile, labeled):
    items = [(n, lab["enemy"]) for n, lab in labeled(kind_not_null=True, exclude_fadein=True)
             if lab["enemy"] and lab["kind"] != "squad_wipe"]
    assert len(items) >= 20
    for i, (na, ea) in enumerate(items):
        for nb, eb in items[i + 1:]:
            if ea != eb:
                assert not _similar(zh_detector, zh_profile, na, nb), (na, nb)


def test_name_sig_shape(zh_detector, labeled):
    for name, lab in labeled(kind_not_null=True, exclude_fadein=True):
        sig = _sig(zh_detector, name)
        if lab["kind"] == "squad_wipe":
            assert sig is None, name
            continue
        assert sig is not None, name
        assert sig.bits.shape == (16, sig.width), name
        assert set(np.unique(sig.bits)) <= {0, 1}
        assert 10 <= sig.width <= 400, name


def test_stacked_banner():
    pytest.skip("spec §3: no stacking observed")


def test_masks(zh_profile):
    img = np.zeros((4, 4, 3), np.uint8)
    img[0, 0] = (255, 255, 255)   # 白
    img[0, 1] = (40, 40, 220)     # 紅（BGR）
    img[0, 2] = (200, 120, 60)    # 藍：兩者皆非
    assert white_mask(img, zh_profile)[0].tolist() == [255, 0, 0, 0]
    assert red_mask(img, zh_profile)[0].tolist() == [0, 255, 0, 0]


def test_blank_banner(zh_detector):
    r = zh_detector.detect(np.zeros((180, 800, 3), np.uint8), np.zeros((40, 480, 3), np.uint8))
    assert isinstance(r, FrameResult)
    assert r.kind is None and not r.spectating and r.name_sig is None


def test_h_scale_stretch(zh_profile, labeled):
    """banner 被水平拉伸 1.1 倍時，對應 h_scale=1/1.1 仍能判對。"""
    import cv2
    det = Detector(zh_profile, h_scale=1 / 1.1)
    for kind in ("knock", "assist_knock", "elim", "squad_wipe"):
        name, _ = labeled(kind=kind, exclude_fadein=True)[0]
        banner, spec = load_fixture(name)
        wide = cv2.resize(banner, (int(round(800 * 1.1)), 180), interpolation=cv2.INTER_LINEAR)
        assert det.detect(wide, spec).kind == kind, name


def test_best_scale_score(zh_detector, labeled):
    name, _ = labeled(kind="knock", exclude_fadein=True)[0]
    banner, _ = load_fixture(name)
    assert zh_detector.best_scale_score(banner, 1.0) > 0.75
    assert zh_detector.best_scale_score(banner, 1.0) > zh_detector.best_scale_score(banner, 1.15)


def test_detect_speed(zh_detector, labeled):
    name, _ = labeled(kind="knock", exclude_fadein=True)[0]
    banner, spec = load_fixture(name)
    zh_detector.detect(banner, spec)
    t0 = time.perf_counter()
    for _ in range(200):
        zh_detector.detect(banner, spec)
    avg_ms = (time.perf_counter() - t0) / 200 * 1000
    assert avg_ms < 3.0, f"{avg_ms:.2f} ms"
