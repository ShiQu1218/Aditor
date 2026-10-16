"""en 與 ja 範本設定檔、多語載入（resolve_profiles）、日文語序與自動語言校準測試。"""
import cv2
import numpy as np
import pytest

from apexhl.calibrate import calibrate_auto
from apexhl.detect import Detector, same_name
from apexhl.models import VideoInfo
from apexhl.profile import load_profile, resolve_profiles
from conftest import REPO, make_video


def _imread_gray(path):
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_profile_loads_and_templates_are_binary_masks(lang):
    p = load_profile(REPO / "templates" / lang)
    assert p.lang == lang
    assert p.templates_version == f"{lang}@1"
    assert {"squad_wipe", "assist", "knock", "damage", "elim", "elim_done", "enemy_squad_down"} <= set(p.keywords)
    assert p.banner_roi == (560, 700, 800, 180)
    assert p.spec_roi == (60, 1028, 480, 40)
    for spec in [*p.keywords.values(), *p.spec_templates]:
        t = _imread_gray(p.dir / spec.file)
        assert set(np.unique(t)) <= {0, 255}, (lang, spec.file)
        assert 0.05 < (t > 0).mean() < 0.6, (lang, spec.file)


def test_resolve_profiles_single_and_auto():
    single = resolve_profiles(REPO / "templates" / "en")
    assert [p.lang for p in single] == ["en"]
    auto_root = resolve_profiles(REPO / "templates")
    assert [p.lang for p in auto_root] == ["zh-TW", "en", "ja"]
    auto_sub = resolve_profiles(REPO / "templates" / "auto")
    assert [p.lang for p in auto_sub] == ["zh-TW", "en", "ja"]


def _paste_mask(canvas: np.ndarray, mask: np.ndarray, x: int, y: int, bgr=(255, 255, 255)) -> None:
    h, w = mask.shape
    roi = canvas[y:y + h, x:x + w]
    roi[mask > 0] = bgr


def test_en_detector_events_and_cross_lang_isolation():
    p_en = load_profile(REPO / "templates" / "en")
    p_zh = load_profile(REPO / "templates" / "zh-TW")
    p_ja = load_profile(REPO / "templates" / "ja")
    d_en, d_zh, d_ja = Detector(p_en), Detector(p_zh), Detector(p_ja)
    spec = np.zeros((40, 480, 3), np.uint8)

    # 合成英文 KNOCKED DOWN + 紅字名 + +150 + DAMAGE INFLICTED
    banner = np.zeros((180, 800, 3), np.uint8)
    kw_knock = _imread_gray(p_en.dir / p_en.keywords["knock"].file)
    kw_dmg = _imread_gray(p_en.dir / p_en.keywords["damage"].file)
    kw_elim = _imread_gray(p_en.dir / p_en.keywords["elim_done"].file)
    _paste_mask(banner, kw_knock, 180, 81, (255, 255, 255))
    # 放入一段紅字名稱（使用 HDR 偏亮紅 BGR=(150, 150, 230) 驗證 r_diff_min）與右側 +150 白字
    name_glyph = kw_dmg[:, :60]
    _paste_mask(banner, name_glyph, 385, 83, (150, 150, 230))
    _paste_mask(banner, kw_knock[:, :40], 500, 81, (255, 255, 255))
    _paste_mask(banner, kw_dmg, 345, 113, (185, 185, 185))

    r_knock = d_en.detect(banner, spec)
    assert r_knock.kind == "knock"
    assert r_knock.damage_line is True
    assert r_knock.name_sig is not None
    assert d_zh.detect(banner, spec).kind is None
    assert d_ja.detect(banner, spec).kind is None

    # 合成英文 ELIMINATED + 同一紅字名 → 指紋應相符
    banner_elim = np.zeros((180, 800, 3), np.uint8)
    _paste_mask(banner_elim, kw_elim, 249, 81, (255, 255, 255))
    _paste_mask(banner_elim, name_glyph, 437, 83, (150, 150, 230))
    r_elim = d_en.detect(banner_elim, spec)
    assert r_elim.kind == "elim"
    assert same_name(r_knock.name_sig, r_elim.name_sig, p_en.name_sig_threshold)


def test_ja_detector_assist_name_between_and_dedupe():
    p_ja = load_profile(REPO / "templates" / "ja")
    d_ja = Detector(p_ja)
    spec = np.zeros((40, 480, 3), np.uint8)

    kw_knock = _imread_gray(p_ja.dir / p_ja.keywords["knock"].file)
    kw_dmg = _imread_gray(p_ja.dir / p_ja.keywords["damage"].file)
    kw_assist = _imread_gray(p_ja.dir / p_ja.keywords["assist"].file)
    kw_ak = _imread_gray(p_ja.dir / p_ja.keywords["assist_knock"].file)
    kw_elim = _imread_gray(p_ja.dir / p_ja.keywords["elim"].file)
    name_glyph = kw_dmg[:, :60]

    # 1. ノックダウン: [Enemy] +150 + 与ダメージ:
    b_knock = np.zeros((180, 800, 3), np.uint8)
    _paste_mask(b_knock, kw_knock, 180, 65, (255, 255, 255))
    _paste_mask(b_knock, name_glyph, 335, 65, (150, 150, 235))
    _paste_mask(b_knock, kw_knock[:, :40], 480, 65, (255, 255, 255))
    _paste_mask(b_knock, kw_dmg, 322, 96, (255, 255, 255))
    rk = d_ja.detect(b_knock, spec)
    assert rk.kind == "knock" and rk.damage_line is True and rk.name_sig is not None

    # 2. アシスト、[Enemy]をダウン（名字夾在 アシスト、 與 をダウン 中間）
    b_ak = np.zeros((180, 800, 3), np.uint8)
    _paste_mask(b_ak, kw_assist, 140, 65, (255, 255, 255))
    _paste_mask(b_ak, name_glyph, 255, 65, (255, 255, 255))
    _paste_mask(b_ak, kw_ak, 360, 65, (255, 255, 255))
    rak = d_ja.detect(b_ak, spec)
    assert rak.kind == "assist_knock" and rak.name_sig is not None
    assert same_name(rk.name_sig, rak.name_sig, p_ja.name_sig_threshold)

    # 3. アシスト、[Enemy]を撃破（名字夾在 アシスト、 與 を撃破 中間）
    b_ae = np.zeros((180, 800, 3), np.uint8)
    _paste_mask(b_ae, kw_assist, 140, 65, (255, 255, 255))
    _paste_mask(b_ae, name_glyph, 255, 65, (255, 255, 255))
    _paste_mask(b_ae, kw_elim, 360, 65, (255, 255, 255))
    rae = d_ja.detect(b_ae, spec)
    assert rae.kind == "assist_elim" and rae.name_sig is not None
    assert same_name(rk.name_sig, rae.name_sig, p_ja.name_sig_threshold)


def test_calibrate_auto_picks_matching_language(tmp_path):
    profiles = resolve_profiles(REPO / "templates")
    p_en = next(p for p in profiles if p.lang == "en")
    banner = np.zeros((180, 800, 3), np.uint8)
    kw_wipe = _imread_gray(p_en.dir / p_en.keywords["squad_wipe"].file)
    _paste_mask(banner, kw_wipe, 254, 81, (255, 255, 255))
    png = tmp_path / "en_wipe.png"
    ok, buf = cv2.imencode(".png", banner)
    assert ok
    buf.tofile(str(png))

    v = make_video(tmp_path, "en_test.mp4", 6, overlay=(png, [(1.0, 5.0)]))
    info = VideoInfo(str(v), 6.0, 1920, 1080, "h264", 0.0, v.stat().st_size, 0.0)
    chosen, scale = calibrate_auto(str(v), info, profiles, max_scan_seconds=10.0)
    assert chosen.lang == "en"
    assert scale == pytest.approx(1.0)
