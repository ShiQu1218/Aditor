"""語言旗標路徑：name_side=left（ja 獨立擊殺）、name_between_assist（ja 助攻）、可選的否決範本。

這些是「邏輯」測試：用真實範本的像素組成畫面，驗證名字擷取的邊界；
偵測準確度由 test_detect_multilang 的真實畫格負責。
"""
import json
import shutil

import cv2
import numpy as np
import pytest

from apexhl.detect import Detector, same_name
from apexhl.profile import load_profile
from conftest import REPO, lang_profile, load_fixture


def _gray(path):
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)


def _paste(canvas, mask, x, y, bgr=(255, 255, 255)):
    h, w = mask.shape
    canvas[y:y + h, x:x + w][mask > 0] = bgr


@pytest.fixture(scope="module")
def ja():
    p = lang_profile("ja")
    return p, Detector(p), {k: _gray(p.dir / v.file) for k, v in p.keywords.items()}


SPEC = np.zeros((40, 480, 3), np.uint8)
NAME = (120, 120, 235)


def _standalone(t, skull=True, name_w=60, noise_left=False):
    """[骷髏] <名字> を撃破：名字用真實 damage 範本的前 name_w 欄當字形。"""
    b = np.zeros((180, 800, 3), np.uint8)
    y, x = 66, 230
    if noise_left:
        _paste(b, t["damage"], 40, y)  # 骷髏左側遠處的 HUD 雜訊
    if skull:
        _paste(b, t["skull"], x, y - 2)
    nx = x + t["skull"].shape[1] + 8
    _paste(b, t["damage"][:, :name_w], nx, y, NAME)
    _paste(b, t["elim"], nx + name_w + 8, y)
    return b


def test_left_name_requires_skull(ja):
    _, d, t = ja
    assert d.detect(_standalone(t, skull=True), SPEC).kind == "elim"
    assert d.detect(_standalone(t, skull=False), SPEC).kind is None  # 沒有骷髏＝不是獨立擊殺


def test_left_name_ignores_noise_left_of_skull(ja):
    _, d, t = ja
    a = d.detect(_standalone(t), SPEC).name_sig
    b = d.detect(_standalone(t, noise_left=True), SPEC).name_sig
    assert a is not None and b is not None
    assert (a.width, a.bits.tobytes()) == (b.width, b.bits.tobytes())  # 寬度不受 x=0 起的雜訊影響


@pytest.mark.parametrize("w", [12, 18, 60, 110])
def test_left_name_one_glyph(ja, w):
    _, d, t = ja
    sig = d.detect(_standalone(t, name_w=w), SPEC).name_sig
    assert sig is not None
    assert sig.bits.shape == (16, sig.width)
    assert abs(sig.width - round(w * 16 / t["damage"].shape[0])) <= 4  # 寬度就是名字本身


def test_between_assist_one_glyph_not_plus100(ja):
    _, d, t = ja
    b = np.zeros((180, 800, 3), np.uint8)
    y = 66
    _paste(b, t["assist"], 140, y)
    gx = 140 + t["assist"].shape[1] + 6
    _paste(b, t["damage"][:, :18], gx, y)
    kx = gx + 18 + 6
    _paste(b, t["assist_knock"], kx, y)
    _paste(b, t["knock"][:, :60], kx + t["assist_knock"].shape[1] + 8, y)  # 代替「+100」的後綴字形
    r = d.detect(b, SPEC)
    assert r.kind == "assist_knock" and r.name_sig is not None
    assert r.name_sig.width <= 20  # 只有單字，沒有把後面的字形算進去


def test_between_assist_same_name_as_standalone(ja):
    p, d, t = ja
    b = np.zeros((180, 800, 3), np.uint8)
    y = 66
    _paste(b, t["assist"], 100, y)
    nx = 100 + t["assist"].shape[1] + 6
    _paste(b, t["damage"][:, :60], nx, y)
    _paste(b, t["assist_knock"], nx + 60 + 6, y)
    sa = d.detect(b, SPEC).name_sig
    sb = d.detect(_standalone(t), SPEC).name_sig
    assert same_name(sa, sb, p.name_sig_threshold)


def _zh_copy(tmp_path, name, drop_veto):
    d = tmp_path / name
    shutil.copytree(REPO / "templates" / "zh-TW", d)
    doc = json.loads((d / "profile.json").read_text(encoding="utf-8"))
    doc["keywords"]["elim_done"]["threshold"] = 0.5  # 讓「已消滅」畫格（elim_done 約 0.6）能過門檻，才看得出否決
    if drop_veto:
        del doc["keywords"]["enemy_squad_down"]
    (d / "profile.json").write_text(json.dumps(doc), encoding="utf-8")
    return load_profile(d)


def test_veto_template_is_optional(tmp_path):
    """enemy_squad_down 是可選鍵：有 → 否決；缺 → vetoed() 跳過，同一格改判為 elim。"""
    labels = json.loads((REPO / "engine/tests/fixtures/zh-TW/labels.json").read_text(encoding="utf-8"))
    names = [n for n, lab in labels.items() if lab.get("tag") == "enemy_squad_down"]
    assert len(names) >= 5
    with_veto = _zh_copy(tmp_path, "a", drop_veto=False)
    without = _zh_copy(tmp_path, "b", drop_veto=True)
    assert with_veto.veto_supported and not without.veto_supported
    d1, d2 = Detector(with_veto), Detector(without)
    assert all(d1.detect(*load_fixture(n)).kind is None for n in names)  # 有範本：全被否決
    assert all(d2.detect(*load_fixture(n)).kind == "elim" for n in names)  # 沒有範本：不否決


def test_no_spec_templates_means_never_spectating(tmp_path):
    d = tmp_path / "zh"
    shutil.copytree(REPO / "templates" / "zh-TW", d)
    doc = json.loads((d / "profile.json").read_text(encoding="utf-8"))
    doc["spec_templates"] = []
    doc["spectating_supported"] = False
    (d / "profile.json").write_text(json.dumps(doc), encoding="utf-8")
    det = Detector(load_profile(d))
    labels = json.loads((REPO / "engine/tests/fixtures/zh-TW/labels.json").read_text(encoding="utf-8"))
    name = next(n for n, lab in labels.items() if lab["spectating"])
    assert not det.detect(*load_fixture(name)).spectating
