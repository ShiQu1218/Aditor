"""敵人名字顏色（色盲模式）的名字指紋：黃（紅／藍色盲）、關閉模式的紅、綠色盲的粉紅。

fixtures/colorblind 是從使用者提供的真實錄影裁出的「只含名字區」小圖（每張 < 50 KB）：
- yellow_*    ：SC1.mkv（簡中介面，紅／藍色盲，名字黃色）
- off_red_*   ：SC2.mkv（簡中介面，關閉模式，名字紅色）
- pink_en_*   ：English.mkv（綠色盲，名字粉紅）
- pink_ja_*   ：Japanese.mkv（綠色盲，名字粉紅）
每個事件（name）兩張相隔 0.25–0.75 s 的畫格。labels.json 記錄來源時間與名字代號。
"""
import copy
import itertools
import json

import cv2
import numpy as np
import pytest

from apexhl.detect import name_sig_from_row, name_sig_similarity, read_name_sig, same_name
from apexhl.profile import load_profile
from conftest import FIXTURES, ICON_DIR

DIR = FIXTURES / "colorblind"
LABELS = json.loads((DIR / "labels.json").read_text(encoding="utf-8"))
MIN_DENSITY = 0.12          # 真名字的指紋墨密度約 0.14–0.31；< 0.03 視為沒有鑑別力
PINK = "green_blind_pink"


def _img(name):
    return cv2.imdecode(np.fromfile(str(DIR / name), dtype=np.uint8), cv2.IMREAD_COLOR)


IMGS = {n: _img(n) for n in LABELS}


@pytest.fixture(scope="module")
def prof():
    return load_profile(ICON_DIR)


def _sig(prof, name):
    return read_name_sig(IMGS[name], prof)


def test_fixtures_are_small():
    assert len(LABELS) == 22
    for n in LABELS:
        assert (DIR / n).stat().st_size < 50_000, n


def test_every_color_mode_gets_a_usable_name_sig(prof):
    for n in LABELS:
        s = _sig(prof, n)
        assert s is not None, n
        assert s.bits.mean() >= MIN_DENSITY, (n, float(s.bits.mean()))


def test_different_names_never_merge(prof):
    sigs = {n: _sig(prof, n) for n in LABELS}
    for a, b in itertools.combinations(LABELS, 2):
        if LABELS[a]["mode"] != LABELS[b]["mode"] or LABELS[a]["name"] == LABELS[b]["name"]:
            continue
        assert not same_name(sigs[a], sigs[b], prof.name_sig_threshold), (a, b)


def test_same_name_frames_correlate_in_every_mode(prof):
    sigs = {n: _sig(prof, n) for n in LABELS}
    by_mode = {}
    for a, b in itertools.combinations(LABELS, 2):
        if LABELS[a]["mode"] == LABELS[b]["mode"] and LABELS[a]["name"] == LABELS[b]["name"]:
            by_mode.setdefault(LABELS[a]["mode"], []).append(name_sig_similarity(sigs[a], sigs[b]))
    assert set(by_mode) == {"yellow", "off_red", PINK}
    for mode, sims in by_mode.items():
        assert float(np.mean(sims)) >= 0.4, (mode, sims)


def test_pink_names_pair_as_same_enemy(prof):
    sigs = {n: _sig(prof, n) for n in LABELS if LABELS[n]["mode"] == PINK}
    pairs = [(a, b) for a, b in itertools.combinations(sigs, 2) if LABELS[a]["name"] == LABELS[b]["name"]]
    assert len(pairs) == 6
    for a, b in pairs:
        assert same_name(sigs[a], sigs[b], prof.name_sig_threshold), (a, b)


def _without_pink(prof):
    p = copy.copy(prof)
    p.red = {k: v for k, v in prof.red.items() if k != "pink"}
    return p


def test_pink_fallback_does_not_touch_red_or_yellow_names(prof):
    """標準遮罩已取得像樣指紋的名字（黃、紅）不會走備援：指紋位元完全相同。"""
    base = _without_pink(prof)
    for n in LABELS:
        if LABELS[n]["mode"] == PINK:
            continue
        a, b = _sig(prof, n), _sig(base, n)
        assert a.width == b.width and np.array_equal(a.bits, b.bits), n


def test_pink_names_are_read_by_the_standard_mask_or_the_fallback_but_never_empty(prof):
    for n in LABELS:
        if LABELS[n]["mode"] == PINK:
            assert name_sig_from_row(IMGS[n], prof, True) is not None, n
