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

from apexhl.detect import Detector, name_sig_similarity, same_name, white_mask
from conftest import FIXTURES, lang_profile

DIR = FIXTURES / "colorblind"
LABELS = json.loads((DIR / "labels.json").read_text(encoding="utf-8"))
LANGS = ("zh-TW", "en", "ja")
MIN_DENSITY = 0.12          # 真名字的指紋墨密度約 0.14–0.31；< 0.03 視為沒有鑑別力
PINK = "green_blind_pink"


def _img(name):
    return cv2.imdecode(np.fromfile(str(DIR / name), dtype=np.uint8), cv2.IMREAD_COLOR)


IMGS = {n: _img(n) for n in LABELS}


def _sig(det, name):
    im = IMGS[name]
    return det._name_sig(im, white_mask(im, det.profile), 0, 0, im.shape[0], True)


def _without_pink(lang):
    p = copy.copy(lang_profile(lang))
    p.red = {k: v for k, v in p.red.items() if k != "pink"}
    return Detector(p)


@pytest.fixture(scope="module", params=LANGS)
def det(request):
    return Detector(lang_profile(request.param))


def test_fixtures_are_small():
    assert len(LABELS) == 22
    for n in LABELS:
        assert (DIR / n).stat().st_size < 50_000, n


def test_every_color_mode_gets_a_usable_name_sig(det):
    for n in LABELS:
        s = _sig(det, n)
        assert s is not None, (det.profile.lang, n)
        assert s.bits.mean() >= MIN_DENSITY, (det.profile.lang, n, float(s.bits.mean()))


def test_different_names_never_merge(det):
    sigs = {n: _sig(det, n) for n in LABELS}
    for a, b in itertools.combinations(LABELS, 2):
        if LABELS[a]["mode"] != LABELS[b]["mode"] or LABELS[a]["name"] == LABELS[b]["name"]:
            continue
        assert not same_name(sigs[a], sigs[b], det.profile.name_sig_threshold), (det.profile.lang, a, b)


def test_same_name_frames_correlate_in_every_mode(det):
    sigs = {n: _sig(det, n) for n in LABELS}
    by_mode = {}
    for a, b in itertools.combinations(LABELS, 2):
        if LABELS[a]["mode"] == LABELS[b]["mode"] and LABELS[a]["name"] == LABELS[b]["name"]:
            by_mode.setdefault(LABELS[a]["mode"], []).append(name_sig_similarity(sigs[a], sigs[b]))
    assert set(by_mode) == {"yellow", "off_red", PINK}
    for mode, sims in by_mode.items():
        assert float(np.mean(sims)) >= 0.4, (det.profile.lang, mode, sims)


@pytest.mark.parametrize("lang", ["zh-TW", "ja"])
def test_pink_names_pair_as_same_enemy(lang):
    d = Detector(lang_profile(lang))
    sigs = {n: _sig(d, n) for n in LABELS if LABELS[n]["mode"] == PINK}
    pairs = [(a, b) for a, b in itertools.combinations(sigs, 2) if LABELS[a]["name"] == LABELS[b]["name"]]
    assert len(pairs) == 6
    for a, b in pairs:
        assert same_name(sigs[a], sigs[b], d.profile.name_sig_threshold), (lang, a, b)


def test_zh_tw_without_pink_rule_cannot_read_pink_names():
    """對照組：zh-TW 的標準紅遮罩（g_max 90）讀不到粉紅名；備援規則才讓它有指紋。"""
    d = _without_pink("zh-TW")
    for n in LABELS:
        if LABELS[n]["mode"] != PINK:
            continue
        s = _sig(d, n)
        assert s is None or s.bits.mean() < 0.03, n


@pytest.mark.parametrize("lang", LANGS)
def test_pink_fallback_does_not_touch_red_or_yellow_names(lang):
    """標準遮罩已取得像樣指紋的名字（黃、紅）不會走備援：指紋位元完全相同。"""
    with_pink, base = Detector(lang_profile(lang)), _without_pink(lang)
    for n in LABELS:
        if LABELS[n]["mode"] == PINK:
            continue
        a, b = _sig(with_pink, n), _sig(base, n)
        assert a.width == b.width and np.array_equal(a.bits, b.bits), (lang, n)


def test_all_three_profiles_define_the_same_pink_rule():
    rules = [lang_profile(l).red["pink"] for l in LANGS]
    assert rules[0] == rules[1] == rules[2]
