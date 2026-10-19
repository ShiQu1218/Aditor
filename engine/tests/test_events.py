import numpy as np

from aditor.events import EventTracker
from aditor.models import FrameResult, NameSig
from aditor.profile import load_profile
from pathlib import Path

PROFILE = load_profile(Path(__file__).resolve().parents[2] / "templates" / "icons")

def sig(seed: int, width: int = 60) -> NameSig:
    rng = np.random.default_rng(seed)
    return NameSig(width, (rng.random((16, width)) > 0.5).astype(np.uint8))


def fr(kind=None, name=None, spec=False, score=0.9, damage=False, hint=None):
    return FrameResult(kind=kind, score=score, x=0, damage_line=damage, name_sig=name, spectating=spec,
                       hint=hint)


def seq(pattern, kind="knock", name=None, t0=0.0):
    """One frame per character (0.25s): '.' is a miss and every other character is a hit. Spaces are ignored."""
    out = []
    i = 0
    for ch in pattern.replace(" ", ""):
        out.append((t0 + i * 0.25, fr(kind if ch != "." else None, name if ch != "." else None)))
        i += 1
    return out


def run(frames, **kw):
    tr = EventTracker(PROFILE, **kw)
    for t, r in frames:
        tr.feed(t, r)
    return tr.finish()


def test_two_frame_minimum():
    ev, _ = run(seq("..K..."))
    assert ev == []


def test_event_time_is_first_hit():
    ev, _ = run(seq("..KKKK"))
    assert len(ev) == 1 and ev[0].t == 0.5
    assert ev[0].id == "a500" and ev[0].type == "knock" and ev[0].source == "auto"


def test_gap_creates_new_event():
    ev, _ = run(seq("KKK..KKK"))
    assert [e.t for e in ev] == [0.0, 1.25]


def test_short_flicker_same_event():
    ev, _ = run(seq("KKK.KKK"))
    assert len(ev) == 1


def test_name_change_new_event():
    # A fade (one blank frame) between banners indicates different enemies (final review I1: a name change without a blank no longer splits; see below).
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a) + seq("KKK", name=b, t0=1.0)
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].t == 1.0
    assert ev[0].name_sig == a.to_b64()


def test_same_name_one_event_and_missing_sig_does_not_split():
    a = sig(1)
    frames = seq("KK", name=a) + seq("KK", name=None, t0=0.5)
    ev, _ = run(frames)
    assert len(ev) == 1


def test_kind_change_new_event():
    frames = seq("AAA", kind="assist_knock") + seq("KKK", kind="knock", t0=0.75)
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["assist_knock", "knock"]


def test_resume_continuation_skipped():
    frames = seq("KKKK..KKK", t0=10.0)
    ev, _ = run(frames, resume_start=10.0)
    assert [e.t for e in ev] == [11.5]


def test_resume_not_hit_at_start_is_normal():
    ev, _ = run(seq(".KKK", t0=10.0), resume_start=10.0)
    assert [e.t for e in ev] == [10.25]


def test_score_max_and_damage_any():
    frames = [(0.0, fr("knock", score=0.7)), (0.25, fr("knock", score=0.95, damage=True)),
              (0.5, fr("knock", score=0.8))]
    ev, _ = run(frames)
    assert ev[0].score == 0.95 and ev[0].damage_line is True


def test_majority_tie_uses_latest_kind_and_updates_on_next_frame():
    tracker = EventTracker(PROFILE)
    for i, kind in enumerate(["knock", "knock", "assist_knock", "assist_knock"]):
        tracker.feed(i * 0.25, fr(kind))
    events, _ = tracker.snapshot()
    assert len(events) == 1 and events[0].type == "assist_knock"
    tracker.feed(1.0, fr("knock"))
    events, _ = tracker.finish()
    assert len(events) == 1 and events[0].type == "knock"


def test_kind_split_rebuilds_score_and_damage_for_both_events():
    frames = [(i * 0.25, fr("assist_knock", score=0.7)) for i in range(3)]
    frames += [(i * 0.25, fr("knock", score=0.99, damage=True)) for i in range(3, 6)]
    events, _ = run(frames)
    assert [(e.t, e.type, e.score, e.damage_line) for e in events] == [
        (0.0, "assist_knock", 0.7, False), (0.75, "knock", 0.99, True),
    ]


def test_continuation_can_establish_pair_without_changing_hit_statistics():
    tracker = EventTracker(PROFILE)
    tracker.feed(0.0, fr("knock", score=0.7))
    tracker.feed(0.25, fr(hint="cont", score=0.99, damage=True))
    events, _ = tracker.snapshot()
    assert [(e.t, e.score, e.damage_line) for e in events] == [(0.0, 0.7, False)]


def test_spectating_interval():
    frames = [(10 + i * 0.25, fr(spec=True)) for i in range(9)]
    _, sp = run(frames)
    assert len(sp) == 1 and sp[0].start == 10.0 and sp[0].end == 12.25
    frames = [(i * 0.25, fr(spec=True)) for i in range(7)]
    _, sp = run(frames)
    assert sp == []


def test_spectating_split_by_gap():
    frames = [(i * 0.25, fr(spec=(i != 9))) for i in range(20)]
    _, sp = run(frames)
    assert [(s.start, s.end) for s in sp] == [(0.0, 2.25), (2.5, 5.0)]


def test_aggregates_cover_frames_before_establishment():
    a = sig(1)
    frames = [(0.0, fr("knock", name=a, score=0.95, damage=True)),
              (0.25, fr("knock", score=0.7)), (0.5, fr("knock", score=0.6))]
    ev, _ = run(frames)
    assert len(ev) == 1
    assert ev[0].score == 0.95 and ev[0].damage_line is True
    assert ev[0].name_sig == a.to_b64()


def test_isolated_onset_frame_sets_t():
    ev, _ = run(seq("K.KK"))
    assert [e.t for e in ev] == [0.0]


def test_no_consecutive_pair_no_event():
    ev, _ = run(seq("K.K.K"))
    assert ev == []


def test_pair_then_gap_t_unchanged():
    ev, _ = run(seq("KK.K"))
    assert [e.t for e in ev] == [0.0]


def test_kind_change_lone_first_frame_not_established():
    # Other banners such as standalone eliminations (which Detector treats as no banner) last only one frame: they do not form events or attach to a knock.
    frames = seq("KKK", kind="knock") + seq("...", t0=0.75)
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["knock"]


def test_resume_continuation_with_one_frame_gap():
    ev, _ = run(seq("K.KK", t0=10.0), resume_start=10.0)
    assert ev == []


def test_single_frame_name_jitter_does_not_split():
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a) + seq("K", name=b, t0=0.75) + seq("KKK", name=a, t0=1.0)
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0


def test_two_consecutive_frames_of_new_name_split_from_first_different_frame():
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a) + seq("KK", name=b, t0=1.0)  # One blank frame in between.
    ev, _ = run(frames)
    assert [e.t for e in ev] == [0.0, 1.0]
    assert ev[1].name_sig == b.to_b64()


def test_alternating_names_never_split():
    a, b = sig(1), sig(2)
    frames = []
    for i in range(8):
        frames.append((i * 0.25, fr("knock", a if i % 2 == 0 else b)))
    ev, _ = run(frames)
    assert len(ev) == 1


def test_unstable_name_then_stable_name_is_one_event_with_stable_sig():
    # The first four frames have different fingerprints (jitter), then stabilize: expect one event starting at the first frame, with the stable name signature.
    jit = [sig(10 + i) for i in range(4)]
    stable = sig(99)
    frames = [(i * 0.25, fr("knock", jit[i])) for i in range(4)]
    frames += [(1.0 + i * 0.25, fr("knock", stable)) for i in range(3)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    assert ev[0].name_sig == stable.to_b64()


# --- Fix-ML-2: per-frame name fingerprint jitter (medoid/majority representative signature) ---

def crop(base: NameSig, x0: int, w: int) -> NameSig:
    """A fragment of the same name left after HUD occlusion or a fade."""
    return NameSig(w, base.bits[:, x0:x0 + w].copy())


def noisy(base: NameSig, seed: int, flips: int = 6) -> NameSig:
    """A slight variant of the same name (a few flipped bits) should still be identified as the same person."""
    rng = np.random.default_rng(1000 + seed)
    bits = base.bits.copy()
    idx = rng.choice(bits.size, flips, replace=False)
    bits.reshape(-1)[idx] ^= 1
    return NameSig(base.width, bits)


def test_every_frame_distinct_sig_is_still_one_event():
    # Five consecutive hits with different fingerprints per frame (frame-level jitter) must not cause the whole run to be discarded.
    frames = [(i * 0.25, fr("knock", sig(200 + i))) for i in range(5)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0 and ev[0].type == "knock"


def test_jitter_run_uses_representative_sig_not_first_frame():
    from aditor.detect import same_name
    good = sig(7)
    # Frame 1 has a fragmented fade-in fingerprint; most later frames are variants of the same name, with two unrelated jitter frames in between.
    names = [sig(300), noisy(good, 1), sig(301), noisy(good, 2), noisy(good, 3), sig(302), noisy(good, 4)]
    frames = [(i * 0.25, fr("knock", n)) for i, n in enumerate(names)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    got = NameSig.from_b64(ev[0].name_sig)
    assert same_name(got, good, PROFILE.name_sig_threshold)


def test_jitter_between_two_enemies_still_splits_once():
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a)
    frames += [(1.0, fr("knock", sig(400))), (1.25, fr("knock", sig(401)))]  # Two different jitter frames after one blank.
    frames += seq("KKK", name=b, t0=1.5)
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[0].t == 0.0 and ev[1].t == 1.0  # The new banner starts at the first frame after the blank (including name-jitter frames).
    assert ev[1].name_sig == b.to_b64()


def test_lone_frame_before_split_does_not_leave_phantom_event():
    # One frame has the old name, followed by a stable new name → one event (the old-name frame is not a separate event).
    a, b = sig(1), sig(2)
    frames = seq("K", name=a) + seq("KKKK", name=b, t0=0.25)
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].name_sig == b.to_b64()


def test_jitter_does_not_lower_minimum_frames():
    # Two non-consecutive frames (one blank in between) with different fingerprints still do not form an event.
    frames = [(0.0, fr("knock", sig(500))), (0.5, fr("knock", sig(501)))]
    ev, _ = run(frames)
    assert ev == []
    ev, _ = run([(0.0, fr("knock", sig(500)))])
    assert ev == []


def _runs(*parts):
    """parts: (t0, kind, [name fingerprints...]), one fingerprint per frame (0.25s)."""
    frames = []
    for t0, kind, names in parts:
        frames += [(t0 + i * 0.25, fr(kind, n)) for i, n in enumerate(names)]
    return frames


# --- Fix-ML-2: flickering between assist_knock/assist_elim in the same assist banner does not split it into two events ---

def test_kind_flicker_is_one_event_with_majority_type():
    # Knock and assist-knock share an icon, and fade-in clues are unreliable: brief flicker does not split the event; use the majority type.
    a = sig(7)
    kinds = ["knock", "knock", "assist_knock", "assist_knock", "assist_knock", "assist_knock"]
    frames = [(i * 0.25, fr(k, a)) for i, k in enumerate(kinds)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0 and ev[0].type == "assist_knock"


def test_kind_flicker_in_the_middle_does_not_split():
    kinds = ["knock"] * 4 + ["assist_knock"] * 2 + ["knock"] * 4
    ev, _ = run([(i * 0.25, fr(k)) for i, k in enumerate(kinds)])
    assert len(ev) == 1 and ev[0].type == "knock"


def test_persistent_kind_change_without_gap_splits_at_first_frame_of_new_kind():
    kinds = ["knock"] * 5 + ["assist_knock"] * 5
    ev, _ = run([(i * 0.25, fr(k)) for i, k in enumerate(kinds)])
    assert [(e.t, e.type) for e in ev] == [(0.0, "knock"), (1.25, "assist_knock")]


def test_cont_frames_extend_a_banner_but_do_not_count_as_hits():
    frames = seq("KKK") + [(0.75, fr(hint="cont")), (1.0, fr(hint="cont"))] + seq("KK", t0=1.25)
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    ev, _ = run([(0.0, fr(hint="cont")), (0.25, fr(hint="cont"))])
    assert ev == []


def test_single_non_kill_frame_inside_a_banner_is_noise_but_two_end_it():
    # The banner lasts at least about 8 frames: an uncertain one-frame classification (JP 523.0 type) joins the same event; two consecutive non-kill frames (another banner or one rejected by validation) end it.
    ev, _ = run(seq("KKK.KKK"))
    assert len(ev) == 1
    ev, _ = run(seq("KKK..KKK"))
    assert [e.t for e in ev] == [0.0, 1.25]


def test_assist_elim_is_its_own_family():
    frames = seq("KKK", kind="knock") + seq("HHH", kind="assist_elim", t0=0.75)
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["knock", "assist_elim"]


def test_assist_family_does_not_merge_with_other_kinds():
    a = sig(7)
    frames = [(0.0, fr("assist_knock", a)), (0.25, fr("assist_knock", a)), (0.5, fr("assist_knock", a)),
              (0.75, fr("knock", a)), (1.0, fr("knock", a)), (1.25, fr("knock", a))]
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["assist_knock", "knock"]


def test_recurring_jitter_name_seen_earlier_in_run_does_not_split():
    # If an alternate reading (jitter) previously seen in the same banner appears again for two consecutive frames, it matches confirmed frames and is not a new name.
    a, j, k = sig(1), sig(50), sig(51)
    names = [a, a, a, j, k, noisy(j, 1), noisy(j, 2), a, a]
    frames = [(i * 0.25, fr("knock", n)) for i, n in enumerate(names)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].name_sig == a.to_b64()


# --- Final review I1: a narrowing name without a blank frame (occlusion/fade) is not a new enemy ---

def test_i1_occluded_name_fragment_without_gap_does_not_split():
    full = sig(21, 120)
    names = [full, noisy(full, 1), full, noisy(full, 2)] + [crop(full, 10, 60)] * 3
    frames = [(i * 0.25, fr("knock", n)) for i, n in enumerate(names)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    assert ev[0].name_sig == full.to_b64()


def test_i1_fade_out_fragments_of_assist_banner_do_not_split():
    full = sig(22, 100)
    names = [full, noisy(full, 1), full] + [crop(full, 0, 55)] * 2
    frames = [(i * 0.25, fr("assist_knock", n)) for i, n in enumerate(names)]
    ev, _ = run(frames)
    assert len(ev) == 1


def test_i1_unrelated_name_without_gap_or_score_dip_is_jitter():
    # Held-out observation: after HUD occlusion, ink width drops sharply and the remaining content is unrelated to the original name (not a clipped fragment); the score is unchanged and there is no blank frame.
    # The game shows only one central banner at a time. A new enemy requires a fade (blank) or score dip, so this change belongs to the same run.
    a, b = sig(23, 300), sig(24, 55)
    frames = _runs((0.0, "knock", [a, a, a, a, a, a]), (1.5, "knock", [b, b]))
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].name_sig == a.to_b64()


def test_i1_unrelated_name_after_gap_splits():
    a, b = sig(23, 100), sig(24, 55)
    frames = _runs((0.0, "knock", [a, a, a, a]), (1.25, "knock", [b, b, b]))  # One blank frame.
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].t == 1.25


def test_i1_unrelated_name_with_score_dip_splits():
    a, b = sig(25, 100), sig(26, 80)
    frames = [(i * 0.25, fr("knock", a, score=0.9)) for i in range(4)]
    frames += [(1.0, fr("knock", b, score=0.6)), (1.25, fr("knock", b, score=0.6)), (1.5, fr("knock", b, score=0.9))]
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].t == 1.0


# --- Final review I2: assist_knock → assist_elim for the same enemy must not merge into one run ---

def test_i2_assist_knock_then_assist_elim_are_two_events():
    a = sig(31, 76)
    frames = _runs((0.0, "assist_knock", [a] * 9), (2.5, "assist_elim", [a] * 9))  # One blank frame at 2.25.
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["assist_knock", "assist_elim"]


def test_i2_assist_elim_blip_before_assist_knock_banner_is_not_an_event():
    a = sig(32, 76)
    kinds = ["assist_elim", ".", "assist_knock", "assist_knock", "assist_knock", "assist_knock", "assist_knock"]
    frames = [(i * 0.25, fr(k if k != "." else None, a if k != "." else None)) for i, k in enumerate(kinds)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].type == "assist_knock"


def test_i2_subkind_switch_with_gap_later_in_run_splits():
    a = sig(33, 76)
    kinds = ["assist_knock"] * 8 + ["."] + ["assist_elim"] * 4
    frames = [(i * 0.25, fr(k if k != "." else None, a if k != "." else None)) for i, k in enumerate(kinds)]
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["assist_knock", "assist_elim"]


# --- Acceptance-video regression (test-ENG 510.0): consecutive different enemies with only one "pop" blank between them ---

def test_real_banner_replacement_after_blank_frame_is_not_absorbed_by_junk_sigs():
    # A few noisy fingerprints (occlusion/muzzle flash) appeared in the old banner; one happens to be a fragment of the new name.
    # The banner after the blank may match only the run's representative signature (or its fragments), not be absorbed by a noisy fingerprint.
    a, b = sig(51, 75), sig(52, 110)
    junk1, junk2 = crop(b, 20, 45), crop(b, 40, 50)
    names = [a, a, a, a, junk1, junk1, a, a]
    frames = [(i * 0.25, fr("knock", n)) for i, n in enumerate(names)]
    frames += [(2.25 + i * 0.25, fr("knock", b)) for i in range(5)]   # Only one blank after 1.75 (at 2.0); the new banner starts at 2.25, and a 0.5 t difference is still allowed in one run.
    ev, _ = run(frames)
    assert [e.t for e in ev] == [0.0, 2.25] and ev[1].name_sig == b.to_b64()


def test_blank_gap_inside_banner_with_same_name_still_one_event():
    a = sig(53, 75)
    frames = [(i * 0.25, fr("knock", a if i != 4 else None)) for i in range(10)]
    ev, _ = run(frames)
    assert len(ev) == 1


def test_new_banner_after_blank_starts_at_first_frame_even_if_name_unreadable_for_a_while():
    # test-ENG 510.0: in the new banner after the pop blank, the name is unreadable for the first few frames and becomes readable later.
    # The new event's t must be the first frame after the blank (when the banner first appears), not the frame where the name becomes readable.
    a, b = sig(61, 75), sig(62, 100)
    frames = [(i * 0.25, fr("knock", a)) for i in range(6)]                 # 0 – 1.25
    frames += [(1.75 + i * 0.25, fr("knock", None)) for i in range(6)]      # One blank at 1.5; the name is unreadable from 1.75 through 3.0.
    frames += [(3.25 + i * 0.25, fr("knock", b)) for i in range(4)]
    ev, _ = run(frames)
    assert [e.t for e in ev] == [0.0, 1.75] and ev[1].name_sig == b.to_b64()
    assert ev[0].name_sig == a.to_b64()


def test_blank_then_unreadable_then_same_name_is_still_one_event():
    a = sig(63, 75)
    frames = [(i * 0.25, fr("knock", a)) for i in range(6)]
    frames += [(1.75 + i * 0.25, fr("knock", None)) for i in range(3)] + [(2.5 + i * 0.25, fr("knock", a)) for i in range(3)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
