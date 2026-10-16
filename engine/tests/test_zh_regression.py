"""zh-TW 位元級回歸：凍結的舊偵測器（efc448f）與目前偵測器對全部 zh-TW fixture 的輸出必須相同。

Fix-ML 加了 name_side／name_between_assist 等語言旗標；zh-TW 不設旗標，行為必須完全不變。
"""
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pytest

from apexhl.detect import Detector
from conftest import load_fixture

LEGACY = Path(__file__).parent / "legacy" / "detect_efc448f.py"


@pytest.fixture(scope="module")
def legacy_detector_cls():
    spec = importlib.util.spec_from_file_location("apexhl._detect_efc448f", LEGACY,
                                                  submodule_search_locations=None)
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = "apexhl"  # 相對匯入 .models／.profile 需要
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod.Detector


def _sig_key(sig):
    return None if sig is None else (sig.width, sig.bits.tobytes())


def _key(r):
    return (r.kind, r.score, r.x, r.damage_line, r.spectating, _sig_key(r.name_sig))


def test_zh_tw_all_fixtures_identical_to_efc448f(legacy_detector_cls, zh_profile, labels):
    old, new = legacy_detector_cls(zh_profile), Detector(zh_profile)
    assert len(labels) >= 86
    for name in labels:
        banner, spec = load_fixture(name)
        a, b = old.detect(banner, spec), new.detect(banner, spec)
        assert _key(a) == _key(b), name
        assert old.keyword_scores(banner) == new.keyword_scores(banner), name


def test_zh_tw_profile_has_no_language_flags(zh_profile):
    assert zh_profile.name_side == "right"
    assert zh_profile.name_between_assist is False
    assert zh_profile.spectating_supported is True
    assert "skull" not in zh_profile.keywords
