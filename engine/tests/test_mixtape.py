"""Real Chinese Mixtape crops and replay/streaming regressions; no external video required."""
from pathlib import Path
import json

import cv2
import numpy as np
import pytest

from aditor.detect import Detector
from aditor.derive import derive
from aditor.events import EventTracker
from aditor.live import LiveKills
from aditor.mixtape import text_match
from aditor.models import FrameResult, NameSig


FIXTURES = Path(__file__).parent / "fixtures" / "mixtape"


def read(name):
    return cv2.imdecode(np.fromfile(str(FIXTURES / f"{name}.png"), np.uint8), cv2.IMREAD_COLOR)


@pytest.mark.parametrize("name,kind", [("kill", "kill"), ("assist", "assist_elim")])
def test_text_only_banners_without_damage(profile, name, kind):
    r = Detector(profile).detect(read(f"{name}_banner"), read(f"{name}_spec"))
    assert r.kind == kind
    assert not r.damage_line and not r.spectating
    assert r.name_sig is not None


def test_self_victim_is_rejected_even_with_capitalized_name(profile):
    detector = Detector(profile)
    banner = read("self_banner")
    # The same exact banner is a positive with a different local HUD name.
    assert detector.detect(banner, read("other_spec")).kind == "kill"
    assert detector.detect(banner, read("assist_spec")).kind is None


@pytest.mark.parametrize("suffix", ["", "123"])
def test_complete_player_name_without_speaker(profile, suffix):
    spec = read("assist_spec")
    spec[:40, 231:330] = 0  # Remove the trailing speaker, preserving the name.
    if suffix:
        cv2.putText(spec, suffix, (231, 31), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                    (255, 255, 255), 1, cv2.LINE_AA)
    result = Detector(profile).detect(read("self_banner"), spec)
    # A shared name prefix is a different player; exact names are still excluded.
    assert result.kind == ("kill" if suffix else None)


def test_player_name_cannot_trigger_spectating(profile):
    template = cv2.imdecode(np.fromfile(str(profile.dir / "spec_en_next_mate.png"), np.uint8),
                            cv2.IMREAD_GRAYSCALE)
    h, w = template.shape
    spec = np.zeros((profile.spec_roi[3], profile.spec_roi[2], 3), np.uint8)
    spec[15:15 + h, 112:112 + w] = template[..., None]
    detector = Detector(profile)
    assert not detector._spectating(spec)
    spec[:] = 0
    spec[80:80 + h, 112:112 + w] = template[..., None]
    assert detector._spectating(spec)


def test_missing_player_hud_does_not_guess_replay_ownership(profile):
    assert Detector(profile).detect(read("kill_banner"), np.zeros_like(read("kill_spec"))).kind is None
    assert Detector(profile).detect(read("kill_banner"), np.zeros((40, 480, 3), np.uint8)).kind is None


@pytest.mark.parametrize("color", [(40, 40, 230), (175, 155, 225), (30, 200, 220)])
def test_enemy_name_colors(profile, color):
    banner = read("kill_banner")
    hsv = cv2.cvtColor(banner, cv2.COLOR_BGR2HSV)
    yellow = (hsv[..., 0] >= 15) & (hsv[..., 0] <= 40) & (hsv[..., 1] >= 90) & (hsv[..., 2] >= 120)
    # Recolor only the name, keeping the keyword and background untouched.
    roi = np.zeros_like(yellow)
    roi[65:95, 395:485] = True
    banner[yellow & roi] = color
    assert Detector(profile).detect(banner, read("kill_spec")).kind == "kill"


@pytest.mark.parametrize("name", ["kill", "assist"])
def test_respawn_events_are_counted_and_live_calibration_keeps_plain_banners(profile, name):
    banner, spec = read(f"{name}_banner"), read(f"{name}_spec")
    detector, tracker = Detector(profile), EventTracker(profile)
    live = LiveKills(profile, calib_max_scan=1.0, learn_seconds=1.0)
    empty = np.zeros_like(banner)
    for i in range(32):
        t = i * 0.25
        b = banner if i < 8 or 20 <= i < 28 else empty
        tracker.feed(t, detector.detect(b, spec))
        live.feed(t, b, spec)
    events, intervals = tracker.finish()
    offline = derive(events, intervals, profile)
    actual, _ = live.finish()
    assert len(offline) == 2
    assert all(e.counted for e in offline)
    assert [e.to_dict() for e in actual] == [e.to_dict() for e in offline]


def test_flat_float_correlation_does_not_create_a_banner(profile):
    detector = Detector(profile)
    for level in (0.0, 0.001, 0.5, 1.0):
        for _, template in detector.mixtape.templates:
            assert text_match(np.full((60, 800), level, np.float32), template)[0] == 0


def test_player_name_capture_survives_supported_layouts(profile):
    from aditor.layout import Layout, SPEC_ANCHOR, SUPPORTED_ASPECTS
    spec = read("assist_spec")
    for ratio in SUPPORTED_ASPECTS.values():
        layout = Layout.from_ratio(ratio)
        capture = profile.capture_spec
        _, sy, _, sh = layout.source_rect(profile.spec_roi, SPEC_ANCHOR)
        raw = np.zeros((capture[3], capture[2], 3), np.uint8)
        top, bottom = round(sy) - capture[1], round(sy + sh) - capture[1]
        raw[top:bottom] = cv2.resize(spec, (480, bottom - top))
        restored = layout.extract(raw, capture, profile.spec_roi, SPEC_ANCHOR)
        assert Detector(profile).detect(read("self_banner"), restored).kind is None


@pytest.mark.parametrize("name,count", [("fade", 1), ("replacement", 2), ("occlusion", 1)])
def test_real_banner_transitions(profile, name, count):
    frames = json.loads((FIXTURES / "transitions.json").read_text())[name]
    tracker = EventTracker(profile)
    for t, raw in frames:
        sig = raw["name_sig"]
        tracker.feed(t, FrameResult(**{**raw, "name_sig": NameSig.from_b64(sig) if sig else None}))
    events, _ = tracker.finish()
    assert len(events) == count


@pytest.mark.parametrize("first_frames", [2, 3, 4, 8])
def test_adjacent_assists_have_distinct_names(profile, first_frames):
    detector = Detector(profile)
    tracker = EventTracker(profile)
    for i in range(first_frames + 12):
        name = "assist_first" if i < first_frames else "assist_second"
        tracker.feed(i * 0.25, detector.detect(read(f"{name}_banner"), read(f"{name}_spec")))
    events, _ = tracker.finish()
    assert [e.type for e in events] == ["assist_elim", "assist_elim"]
