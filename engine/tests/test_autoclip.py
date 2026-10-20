import pytest

from aditor.autoclip import auto_clips
from aditor.models import AutoClipParams, Clip, Event


def make_event(
    t: float,
    id: str | None = None,
    type: str = "knock",
    counted: bool = True,
    counted_override: bool | None = None,
    deleted: bool = False,
) -> Event:
    event_id = id if id is not None else f"e_{int(round(t * 1000))}"
    return Event(
        id=event_id,
        t=t,
        type=type,
        score=0.9,
        damage_line=False,
        name_sig=None,
        counted=counted,
        counted_reason="first" if counted else "",
        counted_override=counted_override,
        source="auto",
        deleted=deleted,
    )


P = AutoClipParams()  # gap=20, n=3, before=8, after=4, max_len=90


def test_basic_triple():
    # [100, 105, 110] → [(92, 114)]
    events = [make_event(100.0), make_event(105.0), make_event(110.0)]
    clips = auto_clips(events, P, 200.0)
    assert len(clips) == 1
    c = clips[0]
    assert (c.start, c.end) == (92.0, 114.0)
    assert c.origin == "ai"
    assert c.id == "c92000"
    assert c.event_ids == ["e_100000", "e_105000", "e_110000"]


def test_below_n():
    # [100, 105] → []
    events = [make_event(100.0), make_event(105.0)]
    clips = auto_clips(events, P, 200.0)
    assert clips == []


def test_gap_breaks_group():
    # [100, 105, 126, 130, 135] → only [126, 130, 135] → [(118, 139)]
    events = [
        make_event(100.0),
        make_event(105.0),
        make_event(126.0),
        make_event(130.0),
        make_event(135.0),
    ]
    clips = auto_clips(events, P, 200.0)
    assert len(clips) == 1
    c = clips[0]
    assert (c.start, c.end) == (118.0, 139.0)
    assert c.id == "c118000"
    assert c.event_ids == ["e_126000", "e_130000", "e_135000"]


def test_clamped_to_video():
    # [2, 4, 6], duration=8 → [(0, 8)]
    events = [make_event(2.0), make_event(4.0), make_event(6.0)]
    clips = auto_clips(events, P, 8.0)
    assert len(clips) == 1
    c = clips[0]
    assert (c.start, c.end) == (0.0, 8.0)
    assert c.id == "c0"
    assert c.event_ids == ["e_2000", "e_4000", "e_6000"]


def test_max_len_split():
    # Times 0, 15, ..., 180 (one kill every 15 seconds, 13 kills) → each clip is ≤ 90 seconds and covers every event.
    ts = [float(i * 15) for i in range(13)]  # 0, 15, ..., 180
    events = [make_event(t) for t in ts]
    clips = auto_clips(events, P, 300.0)

    assert len(clips) > 1
    for c in clips:
        assert c.end - c.start <= P.max_len + 1e-9
        assert c.origin == "ai"
        assert c.id == f"c{int(round(c.start * 1000))}"

    for e in events:
        # Every event lies inside some clip
        assert any(c.start <= e.t <= c.end for c in clips), f"Event at {e.t} not in any clip"

    # All event IDs are covered
    all_covered_ids = {eid for c in clips for eid in c.event_ids}
    assert all_covered_ids == {e.id for e in events}


def test_overlap_merge():
    # The two groups total ≤ 90 after merging, so they form one clip.
    # params: gap=10, before=8, after=4, max_len=90
    params = AutoClipParams(gap=10.0, n=3, before=8.0, after=4.0, max_len=90.0)
    # Group 1: [10, 12, 14] -> clip [2, 18]
    # Group 2: [25, 27, 29] -> clip [17, 33] (25 - 14 = 11 > 10, so two distinct groups)
    # Overlap region: [17, 18]. Merged span: 33 - 2 = 31 <= 90 -> merged into [2, 33]
    events = [
        make_event(10.0),
        make_event(12.0),
        make_event(14.0),
        make_event(25.0),
        make_event(27.0),
        make_event(29.0),
    ]
    clips = auto_clips(events, params, 100.0)
    assert len(clips) == 1
    c = clips[0]
    assert (c.start, c.end) == (2.0, 33.0)
    assert c.id == "c2000"
    assert len(c.event_ids) == 6
    assert c.event_ids == [e.id for e in sorted(events, key=lambda x: x.t)]


def test_overlap_no_merge_midpoint():
    # The merged span exceeds 90, so the first end and second start both equal the overlap midpoint.
    params = AutoClipParams(gap=10.0, n=3, before=8.0, after=4.0, max_len=90.0)
    # Group 1: [10, 20, 30, 40, 50, 60, 70, 80] -> clip [2, 84]
    # Group 2: [91, 100, 110, 120, 130, 140, 150, 160] -> clip [83, 164]
    # 91 - 80 = 11 > 10, separate groups. Overlap: [83, 84].
    # Merged length: 164 - 2 = 162 > 90.
    # Midpoint of overlap: (83 + 84) / 2 = 83.5.
    grp1 = [float(t) for t in range(10, 81, 10)]
    grp2 = [91.0] + [float(t) for t in range(100, 161, 10)]
    events = [make_event(t) for t in grp1 + grp2]
    clips = auto_clips(events, params, 200.0)

    assert len(clips) == 2
    c1, c2 = clips
    assert c1.start == 2.0
    assert c1.end == 83.5
    assert c2.start == 83.5
    assert c2.end == 164.0
    assert c1.id == "c2000"
    assert c2.id == "c83500"


def test_uses_final_counted():
    # Events with counted_override=False are excluded; counted_override=True and deleted states are reflected normally.
    events = [
        make_event(100.0, counted=True, counted_override=None),
        make_event(105.0, counted=True, counted_override=False),  # override to not counted
        make_event(110.0, counted=False, counted_override=True),  # override to counted
        make_event(115.0, counted=True, counted_override=None),
    ]
    # Counted events are: 100, 110, 115 (3 events)
    clips = auto_clips(events, P, 200.0)
    assert len(clips) == 1
    c = clips[0]
    assert (c.start, c.end) == (92.0, 119.0)
    assert "e_105000" not in c.event_ids
    assert "e_110000" in c.event_ids

    # If deleted=True, it is excluded
    deleted_events = [
        make_event(200.0, counted=True),
        make_event(205.0, counted=True, deleted=True),
        make_event(210.0, counted=True),
    ]
    # Only 200 and 210 remain, which is 2 < n=3 -> no clip
    assert auto_clips(deleted_events, P, 300.0) == []


def test_empty_and_no_counted():
    assert auto_clips([], P, 100.0) == []
    events = [make_event(10.0, counted=False), make_event(20.0, deleted=True)]
    assert auto_clips(events, P, 100.0) == []


def test_identical_time_exceeds_max_len():
    # If a group of identical-time events still exceeds max_len (e.g. before + after > max_len)
    # Emit clip clamped to max_len centred on the group
    params = AutoClipParams(gap=20.0, n=3, before=10.0, after=10.0, max_len=12.0)
    events = [make_event(50.0, id="e1"), make_event(50.0, id="e2"), make_event(50.0, id="e3")]
    clips = auto_clips(events, params, 100.0)
    assert len(clips) == 1
    c = clips[0]
    # Center = 50.0, max_len = 12.0 -> [44.0, 56.0]
    assert c.start == 44.0
    assert c.end == 56.0
    assert c.end - c.start == pytest.approx(12.0)


def test_subgroup_below_n_dropped_when_split():
    # When len(grp) < 2 * n and the span exceeds max_len, splitting must not produce a clip from a subgroup smaller than n.
    params = AutoClipParams(gap=20.0, n=3, before=8.0, after=4.0, max_len=30.0)
    # 5 events: [10, 15, 20, 25, 35]. Span = (35 + 4) - (10 - 8) = 39 - 2 = 37 > 30.
    # The largest gap is between 25 and 35 (gap 10).
    # Split into [10, 15, 20, 25] (len 4 >= 3, span 29 - 2 = 27 <= 30) and [35] (len 1 < 3 -> discard).
    events = [make_event(10.0), make_event(15.0), make_event(20.0), make_event(25.0), make_event(35.0)]
    clips = auto_clips(events, params, 100.0)
    assert len(clips) == 1
    c = clips[0]
    assert c.start == 2.0   # 10 - 8 = 2
    assert c.end == 29.0    # 25 + 4 = 29
    assert "e_35000" not in c.event_ids
    assert c.event_ids == ["e_10000", "e_15000", "e_20000", "e_25000"]



def test_cascade_merge():
    # Chained merge: multiple groups overlap successively and their total span is <= max_len, so merge them into one clip.
    params = AutoClipParams(gap=10.0, n=3, before=8.0, after=4.0, max_len=90.0)
    # Group 1: [10, 12, 14] -> [2, 18]
    # Group 2: [25, 27, 29] -> [17, 33] (overlap at 17-18)
    # Group 3: [40, 42, 44] -> [32, 48] (overlap at 32-33)
    events = [
        make_event(10.0), make_event(12.0), make_event(14.0),
        make_event(25.0), make_event(27.0), make_event(29.0),
        make_event(40.0), make_event(42.0), make_event(44.0),
    ]
    clips = auto_clips(events, params, 100.0)
    assert len(clips) == 1
    assert (clips[0].start, clips[0].end) == (2.0, 48.0)
    assert len(clips[0].event_ids) == 9


def test_events_unsorted_input():
    # auto_clips should group and sort output correctly even when input events are unsorted.
    events = [make_event(110.0), make_event(100.0), make_event(105.0)]
    clips = auto_clips(events, P, 200.0)
    assert len(clips) == 1
    assert (clips[0].start, clips[0].end) == (92.0, 114.0)
    assert clips[0].event_ids == ["e_100000", "e_105000", "e_110000"]


def test_many_equal_gaps_do_not_exhaust_recursion_and_keep_earliest_cuts():
    events = [make_event(float(i * 15)) for i in range(3000)]
    clips = auto_clips(events, P, 45000.0)
    # For equal gaps, prefer the earliest split that retains three events; the final group holds the remaining six.
    assert len(clips) == 999
    assert clips[0].event_ids == [e.id for e in events[:3]]
    assert clips[-1].event_ids == [e.id for e in events[-6:]]
    assert [eid for clip in clips for eid in clip.event_ids] == [e.id for e in events]
    assert all(0 <= clip.start < clip.end <= 45000.0 and clip.end - clip.start <= P.max_len
               for clip in clips)
    assert all(a.end <= b.start for a, b in zip(clips, clips[1:]))

