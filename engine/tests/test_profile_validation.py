"""profile.json 驗證（必要鍵、型別、語言旗標）與多語載入的錯誤訊息。"""
import json
import shutil

import pytest

from apexhl.profile import ProfileError, load_profile, resolve_profiles
from conftest import FIXTURES, REPO

MIN = FIXTURES / "profile_min"


def _copy(tmp_path, mutate=None, name="p"):
    d = tmp_path / name
    shutil.copytree(MIN, d)
    doc = json.loads((d / "profile.json").read_text(encoding="utf-8"))
    if mutate:
        mutate(doc)
    (d / "profile.json").write_text(json.dumps(doc), encoding="utf-8")
    return d


@pytest.mark.parametrize("lang", ["zh-TW", "en", "ja"])
def test_shipped_profiles_validate(lang):
    p = load_profile(REPO / "templates" / lang)
    assert p.lang == lang


def test_optional_keys_default(tmp_path):
    p = load_profile(_copy(tmp_path))
    assert p.name_side == "right" and p.name_between_assist is False
    assert p.spectating_supported is True and not p.veto_supported


@pytest.mark.parametrize("key", ["squad_wipe", "assist", "knock", "damage", "elim", "elim_done"])
def test_required_keyword_missing(tmp_path, key):
    d = _copy(tmp_path, lambda doc: doc["keywords"].pop(key))
    with pytest.raises(ProfileError, match=key):
        load_profile(d)


@pytest.mark.parametrize("mutate,match", [
    (lambda d: d["keywords"]["knock"].update(threshold="0.7"), "threshold"),
    (lambda d: d["keywords"]["knock"].update(threshold=1.5), "threshold"),
    (lambda d: d["keywords"]["knock"].update(threshold=0), "threshold"),
    (lambda d: d["keywords"]["knock"].pop("file"), "file"),
    (lambda d: d.update(banner_roi=[1, 2, 3]), "banner_roi"),
    (lambda d: d.update(banner_roi=[0, 0, 0, 180]), "banner_roi"),
    (lambda d: d.update(line1_rows=[100, 50]), "line1_rows"),
    (lambda d: d.update(line1_rows=[50, 999]), "line1_rows"),
    (lambda d: d["white"].pop("v_min"), "v_min"),
    (lambda d: d.update(name_sig_threshold=0), "name_sig_threshold"),
    (lambda d: d.update(dedupe_window=-1), "dedupe_window"),
    (lambda d: d.update(name_side="middle"), "name_side"),
    (lambda d: d.update(name_between_assist="yes"), "name_between_assist"),
    (lambda d: d.update(lang=""), "lang"),
    (lambda d: d.update(keywords=[]), "keywords"),
])
def test_invalid_field_rejected(tmp_path, mutate, match):
    with pytest.raises(ProfileError, match=match):
        load_profile(_copy(tmp_path, mutate))


def test_name_side_left_requires_skull(tmp_path):
    with pytest.raises(ProfileError, match="skull"):
        load_profile(_copy(tmp_path, lambda d: d.update(name_side="left")))


def test_spectating_flag_consistency(tmp_path):
    with pytest.raises(ProfileError, match="spectating_supported"):
        load_profile(_copy(tmp_path, lambda d: d.update(spectating_supported=False)))
    with pytest.raises(ProfileError, match="spectating_supported"):
        load_profile(_copy(tmp_path, lambda d: d.update(spec_templates=[], spectating_supported=True), "r"))
    p = load_profile(_copy(tmp_path, lambda d: d.update(spec_templates=[], spectating_supported=False), "q"))
    assert p.spectating_supported is False and p.spec_templates == []


def test_resolve_profiles_names_broken_language(tmp_path):
    root = tmp_path / "t"
    shutil.copytree(REPO / "templates" / "zh-TW", root / "zh-TW")
    shutil.copytree(REPO / "templates" / "en", root / "en")
    doc = json.loads((root / "en" / "profile.json").read_text(encoding="utf-8"))
    doc["keywords"]["knock"]["threshold"] = "bad"
    (root / "en" / "profile.json").write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(ProfileError, match="en"):
        resolve_profiles(root)
    # 單一語言壞掉不影響直接載入其他語言
    assert [p.lang for p in resolve_profiles(root / "zh-TW")] == ["zh-TW"]
