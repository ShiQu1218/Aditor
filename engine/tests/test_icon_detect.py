"""Icon detector (aditor.icon_detect/aditor.detect.Detector): per-frame behavior, counterexamples, name fingerprints, and spectating.

Fixtures use existing en/ja frames (training sources English.mkv/Japanese.mkv) and zh-TW frames from the old game. Mask-equivalent compression keeps only
bright or red pixels, preserving white/gray icons for regression tests. The zh-TW fixtures come from the old game, where bonus icons have different meanings;
that behavior is documented as a known limitation (see test_old_season_*), and parameters are not tuned to fit it."""
import json

import cv2
import numpy as np
import pytest

from aditor.detect import Detector, PRODUCT_KINDS, same_name
from aditor.icon_detect import (DEFAULT_SCALES, ICON_NAMES, IconDetector, IconFrame, IconParams,
                                enemy_color_mask)
from aditor.models import FrameResult
from conftest import FIXTURES, ICON_DIR, LANGS, lang_labels, load_fixture


@pytest.fixture(scope="module")
def det(profile):
    return Detector(profile)


def _kind(det, lang, name):
    b, s = load_fixture(name, lang)
    return det.detect(b, s)


@pytest.mark.parametrize("scales", [(1.0,), (0.9, 0.95, 1.0, 1.05, 1.1)])
@pytest.mark.parametrize("lang,name", [("en", "knock_a002500.png"), ("en", "assist_knock_a006500.png"),
                                      ("ja", "assist_elim_a102375.png"), ("en", None)])
def test_scale_scores_match_full_features_without_other_icon_searches(scales, lang, name, monkeypatch):
    if name is None:
        banner = np.zeros((180, 800, 3), np.uint8)
    else:
        banner, _ = load_fixture(name, lang)
    detector = IconDetector(ICON_DIR, scales=scales)
    expected = detector.features(banner)
    best = detector._best
    searched = []

    def tracked(g, key, scales=None):
        searched.append(key)
        return best(g, key, scales)

    monkeypatch.setattr(detector, "_best", tracked)
    actual = detector.score_features(banner)
    for key in ("chev", "chev_x", "chev_y", "chev_scale", "plus", "plus_x", "row_h"):
        assert getattr(actual, key) == getattr(expected, key)
    assert set(searched) <= {"chev", "plus"}


def test_icon_templates_are_small_pngs():
    total = 0
    for k in ICON_NAMES:
        f = ICON_DIR / f"{k}.png"
        assert f.exists(), k
        total += f.stat().st_size
        assert f.stat().st_size < 50_000
    assert total < 500_000


class _ReferenceIconDetector(IconDetector):
    """Unoptimized reference: always search the second-line skull/hand roster, as before the lazy optimization."""

    def _needs_line2_icons(self, f, fig):
        return True


def _reference_detector(profile, scale):
    detector = Detector(profile, icon_scale=scale)
    detector.icons = _ReferenceIconDetector(ICON_DIR, scales=(scale,))
    return detector


def _prepare_and_resolve(detector, banner, spec):
    pending, features = detector.prepare(banner, spec)
    return detector.resolve(pending), features


def _result_key(result):
    return (result.kind, result.score, result.x, result.damage_line,
            result.name_sig.to_b64() if result.name_sig is not None else None,
            result.spectating, result.hint)


def _track_peaks(detector, monkeypatch):
    calls = []
    peaks = detector._peaks

    def tracked(g, key, s, thr):
        calls.append(key)
        return peaks(g, key, s, thr)

    monkeypatch.setattr(detector, "_peaks", tracked)
    return calls


@pytest.mark.parametrize("lang,name", [
    ("en", "knock_a002500.png"),              # Plus present and a confident solo figure.
    ("en", "knock_fadein_a048250.png"),       # Plus below plus_min and a confident solo figure.
    ("ja", "assist_knock_fadein_a025600.png"),  # Plus below plus_min, ambiguous figure.
])
def test_roster_search_is_skipped_when_classification_cannot_consume_it(lang, name, monkeypatch):
    banner, _ = load_fixture(name, lang)
    detector = IconDetector(ICON_DIR)
    calls = _track_peaks(detector, monkeypatch)
    f = detector.features(banner)
    assert f.chev >= detector.p.chev_min
    assert f.plus < detector.p.plus_min or detector._figure(f) == "person"
    assert calls == []
    assert f.line2_icons == 0


@pytest.mark.parametrize("lang,name,expected_figure", [
    ("en", "squad_wipe_a007600.png", "group"),
    ("en", "assist_knock_a006475.png", None),
])
def test_roster_search_is_retained_when_classification_uses_it(lang, name, expected_figure, monkeypatch):
    banner, _ = load_fixture(name, lang)
    detector = IconDetector(ICON_DIR)
    calls = _track_peaks(detector, monkeypatch)
    f = detector.features(banner)
    assert f.chev >= detector.p.chev_min and f.plus >= detector.p.plus_min
    assert detector._figure(f) == expected_figure
    assert calls == ["skull", "hand"]


def test_diag_keeps_roster_search_for_a_solo_banner(monkeypatch):
    banner, _ = load_fixture("knock_a002500.png", "en")
    detector = IconDetector(ICON_DIR, diag=True)
    calls = _track_peaks(detector, monkeypatch)
    detector.features(banner)
    assert calls == ["skull", "hand"]


def test_zero_fig_lead_tie_keeps_group_classification():
    detector = IconDetector(ICON_DIR, params=IconParams(fig_lead=0.0))
    f = IconFrame(chev=0.9, plus=0.9, person=0.8, group=0.8)
    assert detector._figure(f) == "group"
    assert detector.classify(f) == "score_other"
    assert detector._needs_line2_icons(f, detector._figure(f))
    f.person = 0.81
    assert detector._figure(f) == "person"
    assert not detector._needs_line2_icons(f, detector._figure(f))


@pytest.mark.parametrize("scale", DEFAULT_SCALES)
def test_lazy_roster_search_preserves_detector_results(profile, scale):
    """Compare every zh-TW/en/ja fixture against the unoptimized feature path at each supported calibration scale."""
    fast = Detector(profile, icon_scale=scale)
    reference = _reference_detector(profile, scale)
    for lang in LANGS:
        for sub in ("pos", "neg"):
            for path in sorted((FIXTURES / lang / sub).glob("*.png")):
                banner, spec = load_fixture(path.name, lang)
                got, got_f = _prepare_and_resolve(fast, banner, spec)
                want, want_f = _prepare_and_resolve(reference, banner, spec)
                where = (lang, path.name)
                assert _result_key(got) == _result_key(want), where
                got_d, want_d = got_f.to_dict(), want_f.to_dict()
                for key, value in want_d.items():
                    if key != "line2_icons":
                        assert got_d[key] == value, (where, key)
                if got_d["line2_icons"] != want_d["line2_icons"]:
                    assert got_d["line2_icons"] == 0, where
                    assert not fast.icons._needs_line2_icons(want_f, fast.icons._figure(want_f)), where


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_non_kill_banners_and_other_screens_are_never_product_events(det, lang):
    """Negative cases include REVIVE/CRATE REVEAL/EVO HARVESTER/BANNER RECOVERY/RESPAWN/RING SCAN, death summary, lobby, spectating,
    and HUD: a three-person banner figure with the same bonus arrow is not a knock/assist."""
    bad = []
    for p in sorted((FIXTURES / lang / "neg").glob("*.png")):
        if _kind(det, lang, p.name).kind in PRODUCT_KINDS:
            bad.append(p.name)
    assert bad == []


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_squad_wipe_and_elim_are_never_product_events(det, lang):
    bad = []
    for p in sorted((FIXTURES / lang / "pos").glob("*.png")):
        if p.stem.startswith(("squad_wipe", "elim")) and _kind(det, lang, p.name).kind in PRODUCT_KINDS:
            bad.append(p.name)
    assert bad == []


@pytest.mark.parametrize("lang,prefix,expect,min_rate", [
    ("en", "knock_a", "knock", 0.85),
    ("ja", "knock_a", "knock", 0.80),
    ("en", "assist_knock_a", "assist_knock", 0.85),
    ("ja", "assist_knock_a", "assist_knock", 0.70),
    ("ja", "assist_elim_a", "assist_elim", 1.0),
])
def test_per_frame_rates_on_training_fixtures(det, lang, prefix, expect, min_rate):
    """Minimum per-frame hit rate for positive examples outside fade-in (fade-in frames may be missed)."""
    ps = sorted((FIXTURES / lang / "pos").glob(f"{prefix}*.png"))
    assert ps
    ok = sum(1 for p in ps if _kind(det, lang, p.name).kind == expect)
    assert ok / len(ps) >= min_rate, (ok, len(ps))


def test_knock_frames_carry_enemy_name_sig_and_damage_line(det):
    r = _kind(det, "en", "knock_a002500.png")
    assert r.kind == "knock" and r.damage_line and r.name_sig is not None and r.name_sig.width > 40
    r = _kind(det, "en", "assist_knock_a006500.png")
    assert r.kind == "assist_knock" and not r.damage_line and r.name_sig is None


def test_same_enemy_same_sig_different_enemy_different_sig(det, profile):
    en = {n: _kind(det, "en", n) for n in ("knock_a002400.png", "knock_a002500.png")}
    a, b = (r.name_sig for r in en.values())
    assert same_name(a, b, profile.name_sig_threshold)
    other = [_kind(det, "en", p.name).name_sig for p in sorted((FIXTURES / "en" / "pos").glob("knock_a02[0-9]*.png"))[:1]]
    assert all(o is None or not same_name(a, o, profile.name_sig_threshold) for o in other)


def test_pink_and_yellow_name_colours_are_enemy_colours():
    px = np.array([[[40, 40, 220], [59, 171, 180], [163, 152, 220], [200, 200, 200]]], np.uint8)  # BGR: red, yellow, pink, white.
    assert enemy_color_mask(px)[0].tolist() == [True, True, True, False]


def test_banner_roi_excludes_top_right_kill_counter(profile):
    """The upper-right kill count and squad survival count are outside banner_roi, so false positives are structurally impossible."""
    x, y, w, h = profile.banner_roi
    assert y > 540 and x + w < 1920 - 400 and y + h < 1080


# ---- Behavior on old-game (zh-TW) fixtures: documented known limitations ----

def test_old_season_behaviour_is_documented_not_tuned(det):
    """In the old game (2026-07), three specific banners use the solo bonus icon.
    Icon detection cannot distinguish these from knock/assist-knock without text or score values, so they are misclassified as knock/assist_knock.
    Other behavior (knock, assist-knock, assist-elim, standalone elim, other screens, and spectating) matches the current game.
    The values below freeze current behavior. If detector changes alter them, update these values and record the change in the accuracy report."""
    lab = lang_labels("zh-TW")
    assert len(lab) == 86
    got = {}
    for n, v in lab.items():
        r = _kind(det, "zh-TW", n)
        key = (v["kind"], bool(v.get("fadein")), r.kind)
        got[key] = got.get(key, 0) + 1
    ok = lambda k: sum(c for (kind, fade, res), c in got.items() if kind == k and not fade and res == k)  # noqa: E731
    assert ok("knock") == 7 and ok("assist_knock") == 6 and ok("assist_elim") == 6
    assert got.get(("elim", False, None)) == 9            # No false positives for standalone eliminations.
# Known limitation: all 6 old-game squad wipes are misclassified as solo bonus banners; 8 other negative cases are false positives (7 squad-eliminated + 1 POI visited).
    assert got.get(("squad_wipe", False, "knock"), 0) + got.get(("squad_wipe", False, "assist_knock"), 0) == 6
    assert got.get((None, False, "knock"), 0) + got.get((None, False, "assist_knock"), 0) == 8


@pytest.mark.xfail(strict=True, reason="The old-game +50 banner also uses the solo bonus icon, "
                                      "which icon detection cannot distinguish from assist-knock; known limitation, do not tune to fit.")
def test_old_season_enemy_squad_down_is_rejected(det):
    for p in sorted((FIXTURES / "zh-TW" / "neg").glob("enemy_squad_down_*.png")):
        assert _kind(det, "zh-TW", p.name).kind not in PRODUCT_KINDS, p.name


# ---- Spectating (the only language-dependent template: three languages side by side, any match counts) ----

@pytest.mark.parametrize("lang", LANGS)
def test_spectating_detected_in_every_language_without_choosing_one(det, lang):
    """For all three-language fixtures, every spectating frame must hit and every non-spectating frame must miss
    (cross-language false-positive check: templates from all profile languages produce zero false positives on frames in other languages)."""
    wrong = []
    for n, v in lang_labels(lang).items():
        _, spec = load_fixture(n, lang)
        if det._spectating(spec) != bool(v["spectating"]):
            wrong.append(n)
    assert wrong == []


def test_synthetic_frame_result_defaults():
    r = FrameResult("knock", 0.9, 0, False, None, False)
    assert r.hint is None


def test_single_off_one_scale_detector_never_raises_on_empty_or_unmatched_frames(profile):
    """When calibration returns a non-1.0 scale such as 0.95, frames with no hits (blank or a banner smaller than the template) must not fail due to the default scale."""
    d = Detector(profile, icon_scale=0.95)
    blank = np.zeros((180, 800, 3), np.uint8)
    spec = np.zeros((40, 480, 3), np.uint8)
    assert d.detect(blank, spec).kind is None
    assert IconDetector(ICON_DIR, scales=(1.1,)).features(np.zeros((40, 800, 3), np.uint8)).kind is None


@pytest.mark.parametrize("scale", [0.9, 0.95, 1.0, 1.05, 1.1])
def test_every_calibration_scale_is_a_valid_detector_scale(profile, scale):
    r = Detector(profile, icon_scale=scale).detect(*load_fixture("knock_a002500.png", "en"))
    assert r.kind in ("knock", None)
