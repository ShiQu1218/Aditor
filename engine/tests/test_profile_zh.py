"""zh-TW 範本與 fixture 的健全性測試（只用 OpenCV 直接比對，不依賴 detect.py）。"""
import json

import cv2
import numpy as np
import pytest

from apexhl.profile import load_profile
from conftest import FIXTURES, REPO

ZH = REPO / "templates" / "zh-TW"
FX = FIXTURES / "zh-TW"


def _imread(path, flag=cv2.IMREAD_COLOR):
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), flag)


def _best(mask, tpl):
    return float(cv2.matchTemplate(mask, tpl, cv2.TM_CCOEFF_NORMED).max())


def _white(img, p):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return (((hsv[..., 2] >= p.white["v_min"]) & (hsv[..., 1] <= p.white["s_max"])).astype(np.uint8) * 255)


@pytest.fixture(scope="module")
def prof():
    return load_profile(ZH)


@pytest.fixture(scope="module")
def tpls(prof):
    kw = {k: _imread(prof.dir / v.file, cv2.IMREAD_GRAYSCALE) for k, v in prof.keywords.items()}
    sp = [_imread(prof.dir / v.file, cv2.IMREAD_GRAYSCALE) for v in prof.spec_templates]
    return kw, sp


def _frame(name, lab, prof):
    img = _imread(FX / ("pos" if lab["kind"] else "neg") / name)
    bh = prof.banner_roi[3]
    sw, sh = prof.spec_roi[2], prof.spec_roi[3]
    return img[:bh], img[bh:bh + sh, :sw]


def test_zh_profile_loads():
    p = load_profile(REPO / "templates/zh-TW")
    assert p.templates_version == "zh-TW@3"
    assert {"squad_wipe", "assist", "knock", "damage", "elim"} <= set(p.keywords)
    x, y, w, h = p.banner_roi
    assert 0 <= x and x + w <= 1920 and y + h <= 1080
    assert p.spec_roi[2] <= w


def test_templates_are_binary_masks(prof):
    for spec in [*prof.keywords.values(), *prof.spec_templates]:
        t = _imread(prof.dir / spec.file, cv2.IMREAD_GRAYSCALE)
        assert set(np.unique(t)) <= {0, 255}, spec.file
        assert 0.05 < (t > 0).mean() < 0.6, spec.file


def test_fixture_inventory(labels):
    kinds = [l["kind"] for l in labels.values()]
    for k in ("knock", "assist_knock", "assist_elim", "elim", "squad_wipe"):
        assert sum(1 for l in labels.values() if l["kind"] == k and not l.get("fadein")) >= 3, k
    assert sum(1 for l in labels.values() if l.get("fadein")) >= 1
    assert kinds.count(None) >= 15
    assert any(l["spectating"] for l in labels.values())
    files = {p.name for d in ("pos", "neg") for p in (FX / d).glob("*.png")}
    assert files == set(labels)
    for n, l in labels.items():
        assert (n in {p.name for p in (FX / "pos").glob("*.png")}) == (l["kind"] is not None)


def test_fixture_size(labels, prof):
    for name, lab in labels.items():
        img = _imread(FX / ("pos" if lab["kind"] else "neg") / name)
        assert img.shape[1] >= prof.banner_roi[2], name
        assert img.shape[0] >= prof.banner_roi[3] + prof.spec_roi[3], name


_EXPECT = {
    "knock": ("knock", "damage"),
    "assist_knock": ("assist", "knock"),
    "assist_elim": ("assist", "elim"),
    "elim": ("elim_done",),
    "squad_wipe": ("squad_wipe",),
}


def test_templates_hit_positive_fixtures(labels, prof, tpls):
    kw, _ = tpls
    for name, lab in labels.items():
        if lab["kind"] is None or lab.get("fadein"):
            continue
        banner, _spec = _frame(name, lab, prof)
        m = _white(banner, prof)
        for key in _EXPECT[lab["kind"]]:
            if key == "damage" and not lab["damage_line"]:
                continue
            assert _best(m, kw[key]) >= prof.keywords[key].threshold, (name, key)


def test_templates_reject_negative_fixtures(labels, prof, tpls):
    kw, _ = tpls
    for name, lab in labels.items():
        if lab["kind"] is not None:
            continue
        banner, _spec = _frame(name, lab, prof)
        m = _white(banner, prof)
        for key in ("squad_wipe", "assist", "knock", "damage", "elim_done"):
            assert _best(m, kw[key]) < prof.keywords[key].threshold, (name, key)
        if lab.get("tag") != "enemy_squad_down":
            assert _best(m, kw["elim"]) < prof.keywords["elim"].threshold, name
            assert _best(m, kw["enemy_squad_down"]) < prof.keywords["enemy_squad_down"].threshold, name
        else:
            assert _best(m, kw["enemy_squad_down"]) >= prof.keywords["enemy_squad_down"].threshold, name


def test_spectating_templates_match_labels(labels, prof, tpls):
    _, sp = tpls
    for name, lab in labels.items():
        _banner, spec = _frame(name, lab, prof)
        m = _white(spec, prof)
        hit = max(_best(m, t) for t in sp) >= prof.spec_templates[0].threshold
        assert hit == lab["spectating"], name
