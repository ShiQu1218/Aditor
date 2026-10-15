import json
import shutil

import pytest

from apexhl.profile import ProfileError, load_profile
from conftest import FIXTURES

MIN = FIXTURES / "profile_min"


def test_load_profile_min():
    p = load_profile(MIN)
    assert p.lang == "test" and p.banner_roi == (560, 700, 800, 180)
    assert p.keywords["knock"].threshold == 0.75
    assert p.dedupe_window == 90


def test_load_profile_missing_file(tmp_path):
    d = tmp_path / "p"
    shutil.copytree(MIN, d)
    (d / "kw_knock.png").unlink()
    with pytest.raises(ProfileError, match="kw_knock.png"):
        load_profile(d)


def test_load_profile_bad_json(tmp_path):
    (tmp_path / "profile.json").write_text("{bad", encoding="utf-8")
    with pytest.raises(ProfileError):
        load_profile(tmp_path)


def test_load_profile_missing_key(tmp_path):
    d = tmp_path / "p"
    shutil.copytree(MIN, d)
    doc = json.loads((d / "profile.json").read_text(encoding="utf-8"))
    del doc["banner_roi"]
    (d / "profile.json").write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(ProfileError, match="banner_roi"):
        load_profile(d)


def test_profile_line_defaults_and_override(tmp_path):
    p = load_profile(MIN)
    assert p.line1_rows == (50, 108) and p.damage_depth == 40  # 未提供時用預設
    d = tmp_path / "p"
    shutil.copytree(MIN, d)
    doc = json.loads((d / "profile.json").read_text(encoding="utf-8"))
    doc.update(line1_rows=[10, 70], damage_depth=25)
    (d / "profile.json").write_text(json.dumps(doc), encoding="utf-8")
    q = load_profile(d)
    assert q.line1_rows == (10, 70) and q.damage_depth == 25
