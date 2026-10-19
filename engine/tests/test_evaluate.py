import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

import pytest  # noqa: E402

from evaluate import evaluate, hms  # noqa: E402

TRUTH = [(10.0, "knock"), (30.0, "knock"), (55.5, "knock"), (80.0, "knock")]


def test_perfect_match():
    rep = evaluate(TRUTH, list(TRUTH), 1.5)
    st = rep.types["knock"]
    assert st.recall == 1.0 and st.precision == 1.0
    assert rep.offset == 0.0 and st.missed == [] and st.false == []


def test_constant_offset_estimated_and_removed():
    pred = [(t + 0.8, k) for t, k in TRUTH]
    rep = evaluate(TRUTH, pred, 0.5)  # Tolerance is smaller than the offset; without correction, every match would be missed.
    st = rep.types["knock"]
    assert rep.offset == pytest.approx(0.8)
    assert st.recall == 1.0 and st.precision == 1.0


def test_one_miss_and_one_false_positive():
    pred = [(10.0, "knock"), (30.0, "knock"), (80.0, "knock"), (100.0, "knock")]
    rep = evaluate(TRUTH, pred, 1.5)
    st = rep.types["knock"]
    assert st.tp == 3 and st.truth == 4 and st.pred == 4
    assert st.recall == pytest.approx(0.75) and st.precision == pytest.approx(0.75)
    assert st.missed == [55.5] and st.false == [100.0]


def test_types_are_independent():
    truth = [(5.0, "knock"), (9.0, "assist")]
    pred = [(5.0, "knock"), (9.0, "knock")]
    rep = evaluate(truth, pred, 1.5)
    assert rep.types["knock"].precision == 0.5 and rep.types["knock"].recall == 1.0
    assert rep.types["assist"].recall == 0.0


def test_greedy_nearest_pairs_each_event_once():
    truth = [(10.0, "knock"), (11.0, "knock"), (50.0, "knock")]
    pred = [(10.9, "knock"), (50.0, "knock")]
    st = evaluate(truth, pred, 1.5).types["knock"]
    assert st.tp == 2 and st.missed == [10.0]


def test_hms():
    assert hms(3725.4) == "01:02:05"


def test_outplayed_truth_events_and_skip_empty(tmp_path):
    from outplayed_truth import build_truth, truth_events

    media = {"events": [{"type": "kill", "time": 11450.0}, {"type": "knockdown", "time": 3730.4},
                        {"type": "assist", "time": 5000}, {"type": "x", "time": None}]}
    assert truth_events(media) == [
        {"t": 3.73, "type": "knock", "name": None}, {"t": 5.0, "type": "assist", "name": None},
        {"t": 11.45, "type": "kill", "name": None}]
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    a.write_bytes(b"")
    b.write_bytes(b"")
    matches = [{"isServiceDown": False, "medias": [{"path": str(a), "events": media["events"]}]},
               {"isServiceDown": True, "medias": [{"path": str(b), "events": []},
                                                  {"path": str(tmp_path / "gone.mp4"), "events": media["events"]}]}]
    truths, warns = build_truth(matches, None)
    assert list(truths) == [str(a)] and truths[str(a)]["video"] == "a.mp4"
    assert len(warns) == 1 and "b.mp4" in warns[0]


def test_large_systematic_offset_is_not_compensated():
    """M8: do not correct offsets above the limit; count them directly as misses/false positives and retain the raw offset for the report."""
    truth = [(10.0, "knock"), (30.0, "knock"), (50.0, "knock")]
    pred = [(t + 4.0, k) for t, k in truth]
    rep = evaluate(truth, pred, 1.5)
    st = rep.types["knock"]
    assert st.tp == 0 and st.raw_offset == 4.0 and st.offset == 0.0
