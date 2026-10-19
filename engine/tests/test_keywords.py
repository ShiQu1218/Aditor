"""Per-video learned kill keyword templates (detect.Keywords/calibrate.AnchorCollector) filter non-kill banners that use the same solo-score icon.

Use existing fixtures as videos: feed positive frames for one language in sequence (10-second gaps represent separate banners) to learn templates, then validate the remaining frames.
The development set is H950 (Traditional Chinese, 2026-08); zh-TW (old game), en, and ja fixtures are training and regression material. Templates are learned from the corresponding language frames;
the engine itself contains no text templates for any language."""
import numpy as np
import pytest

from aditor.calibrate import AnchorCollector, build_keywords
from aditor.detect import Detector, Keywords, PRODUCT_KINDS, _consensus
from conftest import FIXTURES, lang_labels, load_fixture


def _learn(profile, lang):
    det = Detector(profile, 1.0)
    col = AnchorCollector(profile, det)
    t = 0.0
    for n, v in lang_labels(lang).items():
        if v["kind"] in ("knock", "assist_elim") and not v.get("fadein"):
            col.feed(t, load_fixture(n, lang)[0])
            t += 10.0
    return build_keywords([col])


@pytest.fixture(scope="module")
def zh_kw(profile):
    return _learn(profile, "zh-TW")


def test_roundtrip_and_empty():
    a = (np.random.default_rng(0).random((27, 64)) > 0.7).astype(np.float32)
    kw = Keywords.from_dict(Keywords(a, None).to_dict())
    assert np.array_equal(kw.assist, a) and kw.knock is None and not kw.empty
    assert Keywords.from_dict(None).empty and Keywords().empty


@pytest.mark.parametrize("bad", [
    {"assist": {"shape": [27, 64], "q8": "AAAA"}},            # Data is too short.
    {"assist": {"shape": [27], "q8": "AAAA"}},                # Invalid shape.
    {"knock": {"shape": [2, 2], "q8": "!!!not-base64!!!"}},   # Corrupt base64.
    {"knock": "x"},
    "x",
])
def test_from_dict_rejects_corrupt_cache_with_value_error(bad):
    with pytest.raises(ValueError):
        Keywords.from_dict(bad)


def test_consensus_needs_three_anchors_and_some_ink():
    a = np.ones((4, 4), np.float32)
    assert _consensus([a, a]) is None
    assert _consensus([a, a, a]) is not None
    z = np.zeros((4, 4), np.float32)
    assert _consensus([z, z, z]) is None


def test_zh_learns_both_templates(zh_kw):
    assert zh_kw.assist is not None and zh_kw.knock is not None
    assert zh_kw.assist.shape[1] == 64


def test_old_season_non_kill_single_person_banners_are_rejected_with_learned_keywords(profile, zh_kw):
    """The old game (2026-07) uses solo bonus icons for several banners, causing false positives when there are no keyword templates
    (see test_old_season_behaviour_is_documented_not_tuned); learned templates block all of them."""
    det = Detector(profile, 1.0, keywords=zh_kw)
    bad = []
    for lang_dir in ("neg", "pos"):
        for p in sorted((FIXTURES / "zh-TW" / lang_dir).glob("*.png")):
            n = p.name
            lab = lang_labels("zh-TW")[n]
            if lab["kind"] in (None, "squad_wipe", "elim") and det.detect(*load_fixture(n, "zh-TW")).kind in PRODUCT_KINDS:
                bad.append(n)
    assert bad == []


def test_zh_kill_banners_are_still_detected_with_learned_keywords(profile, zh_kw):
    det = Detector(profile, 1.0, keywords=zh_kw)
    for kind, want in (("knock", 7), ("assist_knock", 6), ("assist_elim", 6)):
        names = [n for n, v in lang_labels("zh-TW").items() if v["kind"] == kind and not v.get("fadein")]
        ok = sum(det.detect(*load_fixture(n, "zh-TW")).kind == kind for n in names)
        assert ok == want, (kind, ok, len(names))


def test_japanese_assists_are_accepted_by_the_assist_prefix_not_the_knock_word(profile):
    kw = _learn(profile, "ja")
    assert kw.assist is not None and kw.knock is not None
    det = Detector(profile, 1.05, keywords=kw)
    names = [n for n, v in lang_labels("ja").items() if v["kind"] == "assist_knock" and not v.get("fadein")]
    ok = sum(det.detect(*load_fixture(n, "ja")).kind == "assist_knock" for n in names)
    assert ok / len(names) >= 0.7


def test_english_without_hand_anchors_uses_the_knock_word_for_assists(profile):
    kw = _learn(profile, "en")
    assert kw.assist is None and kw.knock is not None  # en fixtures have no assist-elim, so an assist prefix cannot be learned.
    det = Detector(profile, 1.0, keywords=kw)
    names = [n for n, v in lang_labels("en").items() if v["kind"] == "assist_knock" and not v.get("fadein")]
    assert sum(det.detect(*load_fixture(n, "en")).kind == "assist_knock" for n in names) / len(names) >= 0.85
    bad = [p.name for p in sorted((FIXTURES / "en" / "neg").glob("*.png"))
           if det.detect(*load_fixture(p.name, "en")).kind in PRODUCT_KINDS]
    assert bad == []


def test_no_keywords_means_icon_only_behaviour(profile):
    assert Detector(profile, 1.0, keywords=Keywords()).keywords is None
