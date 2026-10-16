"""實驗性圖示偵測器（apexhl.icon_detect）的回歸測試。

fixture 都是既有的 en／ja（訓練來源 English.mkv／Japanese.mkv）畫格；遮罩等價壓縮只保留亮或紅的像素，
圖示（白／灰）仍在，所以可以當回歸資料。zh-TW fixture 來自舊版本遊戲：加分圖示語意不同，
記錄成已知限制（xfail），不調參去貼合。"""
from pathlib import Path

import cv2
import numpy as np
import pytest

from apexhl.icon_detect import (ICON_NAMES, IconDetector, IconFrame, IconParams, build_runs,
                                enemy_color_mask)

ROOT = Path(__file__).resolve().parents[2]
TPL = ROOT / "templates" / "icons"
FIX = Path(__file__).resolve().parent / "fixtures"


def _img(p: Path) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(p), np.uint8), cv2.IMREAD_COLOR)[:180]


def _kind(det: IconDetector, p: Path):
    return det.features(_img(p)).kind


@pytest.fixture(scope="module")
def det():
    return IconDetector(TPL)


def test_templates_are_small_pngs():
    total = 0
    for k in ICON_NAMES:
        f = TPL / f"{k}.png"
        assert f.exists(), k
        total += f.stat().st_size
        assert f.stat().st_size < 50_000
    assert total < 500_000


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_non_kill_score_banners_are_not_knock_or_assist(det, lang):
    """REVIVE／CRATE REVEAL／EVO HARVESTER 等（同樣有加分箭頭，但人形是三人）→ 不是 knock／assist。"""
    bad = []
    for p in sorted((FIX / lang / "neg").glob("*.png")):
        k = _kind(det, p)
        if k in ("knock", "assist_knock", "assist_elim"):
            bad.append((p.name, k))
    assert bad == []


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_squad_wipe_and_elim_are_never_knock_or_assist(det, lang):
    bad = []
    for p in sorted((FIX / lang / "pos").glob("*.png")):
        if p.stem.startswith(("squad_wipe", "elim")):
            k = _kind(det, p)
            if k in ("knock", "assist_knock", "assist_elim"):
                bad.append((p.name, k))
    assert bad == []


@pytest.mark.parametrize("lang,prefix,expect,min_rate", [
    ("en", "knock_a", "knock", 0.85),
    ("ja", "knock_a", "knock", 0.80),
    ("en", "assist_knock_a", "assist_knock", 0.85),
    ("ja", "assist_knock_a", "assist_knock", 0.70),
    ("ja", "assist_elim_a", "assist_elim", 1.0),
    ("en", "elim_a", "elim", 1.0),
])
def test_per_frame_rates_on_training_fixtures(det, lang, prefix, expect, min_rate):
    """非淡入正例的逐格命中率下限（量測值見報告；淡入幀允許漏）。"""
    ps = sorted((FIX / lang / "pos").glob(f"{prefix}*.png"))
    assert ps
    ok = sum(1 for p in ps if _kind(det, p) == expect)
    assert ok / len(ps) >= min_rate, (ok, len(ps))


@pytest.mark.xfail(strict=True, reason="舊版本遊戲（zh-TW fixture）的「敵方小隊已消滅 +50」也用單人加分圖示，"
                                      "圖示法無法與助攻擊倒區分；需文字或其他線索")
def test_old_season_enemy_squad_down_is_rejected(det):
    for p in sorted((FIX / "zh-TW" / "neg").glob("enemy_squad_down_*.png")):
        assert _kind(det, p) not in ("knock", "assist_knock", "assist_elim"), p.name


def test_enemy_color_mask_covers_red_yellow_pink():
    px = np.array([[[40, 40, 220], [59, 171, 180], [163, 152, 220], [200, 200, 200]]], np.uint8)  # BGR
    assert enemy_color_mask(px)[0].tolist() == [True, True, True, False]


def _f(kind, **kw):
    f = IconFrame(kind=kind, chev=0.9, plus=0.9, person=0.9, group=0.3, **kw)
    return f


def test_build_runs_merges_flicker_and_maps_products():
    p = IconParams()
    knock = dict(name_color=300)
    frames = ([IconFrame()] * 2 + [_f("knock", **knock)] * 4 + [IconFrame()] + [_f("knock", **knock)] * 3
              + [IconFrame()] * 3 + [IconFrame(kind="elim", skull=0.95)] * 5 + [IconFrame()] * 3
              + [IconFrame(kind="assist_elim", hand=0.95)] * 4)
    ts = [i / 4 for i in range(len(frames))]
    runs = build_runs(ts, frames, p)
    assert [(r["t"], r["product"]) for r in runs] == [(0.5, "knock"), (3.25, None), (5.25, "assist")]


def test_build_runs_splits_knock_then_assist_without_gap():
    p = IconParams()
    frames = [_f("knock", name_color=300)] * 5 + [_f("assist_knock")] * 5
    runs = build_runs([i / 4 for i in range(10)], frames, p)
    assert [(r["t"], r["type"]) for r in runs] == [(0.0, "knock"), (1.25, "assist_knock")]
