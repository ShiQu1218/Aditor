"""自動語言偵測的語意：不悄悄退回、快取有效性、derive 用記錄的語言。"""
import json

import cv2
import numpy as np
import pytest

from apexhl import ENGINE_VERSION
from apexhl.analyze import analyze
from apexhl.cache import needs_reanalysis
from apexhl.calibrate import calibrate_auto
from apexhl.ipc import BadRequest, _pick_profile
from apexhl.models import VideoInfo
from apexhl.profile import resolve_profiles
from conftest import FIXTURES, REPO, make_video

PICK = {"zh-TW": ("pos", "knock_a007700.png"), "en": ("pos", "squad_wipe_a007700.png"),
        "ja": ("pos", "knock_a021475.png")}


def _banner_png(tmp_path, lang):
    sub, name = PICK[lang]
    img = cv2.imdecode(np.fromfile(str(FIXTURES / lang / sub / name), dtype=np.uint8), cv2.IMREAD_COLOR)
    out = tmp_path / f"{lang}_banner.png"
    ok, buf = cv2.imencode(".png", img[:180])
    assert ok
    buf.tofile(str(out))
    return out


def _info(v, duration):
    return VideoInfo(str(v), duration, 1920, 1080, "h264", 0.0, v.stat().st_size, 0.0)


@pytest.fixture(scope="module")
def profiles():
    return resolve_profiles(REPO / "templates")


@pytest.mark.parametrize("lang", ["zh-TW", "en", "ja"])
def test_calibrate_auto_picks_each_language_from_real_banner(tmp_path, profiles, lang):
    v = make_video(tmp_path, f"{lang}.mp4", 6, overlay=(_banner_png(tmp_path, lang), [(1.0, 5.0)]))
    chosen, scale = calibrate_auto(str(v), _info(v, 6.0), profiles, max_scan_seconds=10.0)
    assert chosen is not None and chosen.lang == lang
    assert scale == pytest.approx(1.0)


def test_calibrate_auto_undetermined_is_explicit(tmp_path, profiles):
    v = make_video(tmp_path, "blank.mp4", 4)
    chosen, scale = calibrate_auto(str(v), _info(v, 4.0), profiles, max_scan_seconds=10.0)
    assert chosen is None and scale == 1.0  # 絕不悄悄退回 profiles[0]


def _assist_without_sub_png(tmp_path):
    """模擬簡體中文錄影：「助攻，」看得到，但後面的簡體「击倒」比不到任何子關鍵字 → 偵測器後備成 assist_elim。"""
    from apexhl.detect import Detector, white_mask
    prof = [p for p in resolve_profiles(REPO / "templates") if p.lang == "zh-TW"][0]
    det = Detector(prof)
    img = cv2.imdecode(np.fromfile(str(FIXTURES / "zh-TW" / "pos" / "assist_knock_a007150.png"), dtype=np.uint8),
                       cv2.IMREAD_COLOR)[:180]
    wm = white_mask(img, prof)
    from apexhl.detect import _ink_box
    box = _ink_box(wm, rows_limit=prof.line1_rows)
    s, x, y = det._hit(wm, "assist", box)
    img = img.copy()
    img[:, x + det.tpl["assist"].shape[1]:] = 0
    out = tmp_path / "sc_like.png"
    ok, buf = cv2.imencode(".png", img)
    assert ok
    buf.tofile(str(out))
    return out


def test_simplified_chinese_like_recording_is_undetermined_not_zh_tw(tmp_path, profiles):
    """I5：只有弱類型（assist_elim 後備）命中的錄影不得被判成 zh-TW。"""
    png = _assist_without_sub_png(tmp_path)
    v = make_video(tmp_path, "sc.mp4", 6, overlay=(png, [(1.0, 5.0)]))
    chosen, _ = calibrate_auto(str(v), _info(v, 6.0), profiles, max_scan_seconds=10.0)
    assert chosen is None
    doc = analyze(str(v), profiles, cache_dir=tmp_path / "c", hwaccel=False)
    assert doc["analysis"]["lang_detected"] is False and doc["events"] == []


def test_analyze_auto_undetermined_records_flag_and_is_not_cached(tmp_path, profiles):
    v = make_video(tmp_path, "blank.mp4", 4)
    doc = analyze(str(v), profiles, cache_dir=tmp_path / "c", hwaccel=False)
    a = doc["analysis"]
    assert a["status"] == "done" and a["lang_detected"] is False
    assert a["profile"] is None and doc["profile"] is None
    assert a["spectating_supported"] is None
    assert doc["events"] == []
    # 之後 auto 再分析會重跑（快取不被接受）；指定語言分析也一定重跑
    from apexhl.probe import probe
    info = probe(str(v))
    versions = {p.templates_version for p in profiles}
    assert needs_reanalysis(doc, info, versions, {p.lang for p in profiles})
    assert needs_reanalysis(doc, info, profiles[0].templates_version)


def test_analyze_auto_detected_records_profile_and_spectating_flag(tmp_path, profiles):
    v = make_video(tmp_path, "en.mp4", 8, overlay=(_banner_png(tmp_path, "en"), [(1.0, 7.0)]))
    doc = analyze(str(v), profiles, cache_dir=tmp_path / "c", hwaccel=False)
    a = doc["analysis"]
    assert a["lang_detected"] is True and a["profile"] == "en" and doc["profile"] == "en"
    assert a["spectating_supported"] is True and a["templates_version"] == "en@3"


def _doc(**analysis):
    a = {"status": "done", "engine_version": ENGINE_VERSION, "templates_version": "en@3",
         "profile": "en", "lang_detected": True}
    a.update(analysis)
    return {"video": {"size": 5, "mtime": 1.0}, "analysis": a, "profile": a["profile"]}


class _Info:
    size, mtime = 5, 1.0


KNOWN = {"zh-TW@3", "en@3", "ja@3"}
LANGS = {"zh-TW", "en", "ja"}


def test_needs_reanalysis_auto_accepts_known_profile_cache():
    assert not needs_reanalysis(_doc(), _Info, KNOWN, LANGS)


@pytest.mark.parametrize("analysis", [
    {"lang_detected": False},
    {"templates_version": "fr@1", "profile": "fr"},
    {"templates_version": "auto@undetermined", "profile": None},
    {"templates_version": "en@1"},          # 舊版範本
    {"profile": "fr"},                       # 版本相符但語言不在已知集合
])
def test_needs_reanalysis_auto_rejects_foreign_or_undetermined(analysis):
    assert needs_reanalysis(_doc(**analysis), _Info, KNOWN, LANGS)


def test_needs_reanalysis_single_mode_exact_version():
    assert not needs_reanalysis(_doc(), _Info, "en@3")
    assert needs_reanalysis(_doc(), _Info, "ja@3")
    assert needs_reanalysis(_doc(lang_detected=False), _Info, "en@3")


def test_pick_profile_uses_recorded_language(profiles):
    assert _pick_profile(profiles, "ja").lang == "ja"
    assert _pick_profile(profiles, "en").lang == "en"
    assert _pick_profile(profiles[:1], None).lang == "zh-TW"
    with pytest.raises(BadRequest):
        _pick_profile(profiles, None)          # auto 沒帶記錄的語言
    with pytest.raises(BadRequest):
        _pick_profile(profiles, "fr")
    with pytest.raises(BadRequest):
        _pick_profile(profiles[:1], "ja")      # 單一語言卻記錄了別的語言


def test_ipc_derive_uses_recorded_profile_dedupe(tmp_path):
    """同一份事件，用 zh-TW（預設第一個）與用記錄的 en 去重參數結果相同時也必須明確走 en；
    這裡以 BadRequest 驗證錯誤語言會被擋下，正確語言通過。"""
    from apexhl.ipc import Server
    import io
    out = io.BytesIO()
    s = Server(io.BytesIO(), out)
    args = {"events": [], "spectating": [], "profile_dir": str(REPO / "templates"), "profile": "en"}
    assert s._derive("1", args, None) == {"events": []}
    with pytest.raises(BadRequest):
        s._derive("1", {**args, "profile": None}, None)
    json.dumps(args)


def test_analysis_reports_spectating_unsupported_profile(tmp_path):
    """profile 沒有觀戰範本（spectating_supported=false）→ analysis.spectating_supported=false，App 才能警告。"""
    import shutil
    from apexhl.profile import load_profile
    d = tmp_path / "zh"
    shutil.copytree(REPO / "templates" / "zh-TW", d)
    doc = json.loads((d / "profile.json").read_text(encoding="utf-8"))
    doc["spec_templates"] = []
    doc["spectating_supported"] = False
    (d / "profile.json").write_text(json.dumps(doc), encoding="utf-8")
    v = make_video(tmp_path, "blank.mp4", 3)
    res = analyze(str(v), load_profile(d), cache_dir=tmp_path / "c", hwaccel=False)
    assert res["analysis"]["spectating_supported"] is False
    assert res["analysis"]["lang_detected"] is True and res["analysis"]["profile"] == "zh-TW"
