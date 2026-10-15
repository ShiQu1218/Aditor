import numpy as np

from apexhl.events import EventTracker
from apexhl.models import FrameResult, NameSig
from apexhl.profile import load_profile
from pathlib import Path

PROFILE = load_profile(Path(__file__).resolve().parents[2] / "templates" / "zh-TW")

KINDS = {"K": "knock", "A": "assist_knock", "E": "elim"}


def sig(seed: int, width: int = 60) -> NameSig:
    rng = np.random.default_rng(seed)
    return NameSig(width, (rng.random((16, width)) > 0.5).astype(np.uint8))


def fr(kind=None, name=None, spec=False, score=0.9, damage=False):
    return FrameResult(kind=kind, score=score, x=0, damage_line=damage, name_sig=name, spectating=spec)


def seq(pattern, kind="knock", name=None, t0=0.0):
    """每個字元一格 (0.25s)：'.' 無命中，其他字元命中。空白略過。"""
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
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a) + seq("KKK", name=b, t0=0.75)
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].t == 0.75
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
    frames = seq("KKK", kind="knock") + seq("E", kind="elim", t0=0.75) + seq("..", t0=1.0)
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
    frames = seq("KKK", name=a) + seq("KK", name=b, t0=0.75)
    ev, _ = run(frames)
    assert [e.t for e in ev] == [0.0, 0.75]
    assert ev[1].name_sig == b.to_b64()


def test_alternating_names_never_split():
    a, b = sig(1), sig(2)
    frames = []
    for i in range(8):
        frames.append((i * 0.25, fr("knock", a if i % 2 == 0 else b)))
    ev, _ = run(frames)
    assert len(ev) == 1


def test_unstable_name_then_stable_name_is_one_event_with_stable_sig():
    # 前 4 格每格指紋皆不同（抖動），之後穩定：應為單一事件，起點為第一格，簽名採穩定名字
    jit = [sig(10 + i) for i in range(4)]
    stable = sig(99)
    frames = [(i * 0.25, fr("assist_elim", jit[i])) for i in range(4)]
    frames += [(1.0 + i * 0.25, fr("assist_elim", stable)) for i in range(3)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    assert ev[0].name_sig == stable.to_b64()
