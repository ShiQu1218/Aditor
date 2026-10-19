import numpy as np
import pytest

from aditor.derive import derive, is_counted, sig_similar
from aditor.models import Event, NameSig, SpecInterval


def make_sig(seed: int, width: int = 60) -> str:
    rng = np.random.default_rng(seed)
    bits = (rng.random((16, width)) > 0.5).astype(np.uint8)
    return NameSig(width, bits).to_b64()


def make_event(
    id: str = "e1",
    t: float = 100.0,
    type: str = "knock",
    score: float = 0.9,
    damage_line: bool = False,
    name_sig: str | None = None,
    counted: bool = False,
    counted_reason: str = "",
    counted_override: bool | None = None,
    source: str = "auto",
    deleted: bool = False,
) -> Event:
    return Event(
        id=id,
        t=t,
        type=type,
        score=score,
        damage_line=damage_line,
        name_sig=name_sig,
        counted=counted,
        counted_reason=counted_reason,
        counted_override=counted_override,
        source=source,
        deleted=deleted,
    )


def test_squad_wipe_not_counted(profile):
    e = make_event(id="e1", t=50.0, type="squad_wipe", name_sig=make_sig(1))
    res = derive([e], [], profile)
    assert len(res) == 1
    assert res[0].counted is False
    assert res[0].counted_reason == "not_counting_type"
    assert is_counted(res[0]) is False


def test_spectating_not_counted(profile):
    e = make_event(id="e1", t=50.0, type="knock", name_sig=make_sig(1))
    spec = [SpecInterval(start=40.0, end=60.0)]
    res = derive([e], spec, profile)
    assert len(res) == 1
    assert res[0].counted is False
    assert res[0].counted_reason == "spectating"
    assert is_counted(res[0]) is False


def test_dedupe_same_enemy_within_window(profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a)
    e2 = make_event(id="e2", t=180.0, type="assist_elim", name_sig=sig_a)
    res = derive([e1, e2], [], profile)
    assert len(res) == 2
    assert res[0].counted is True
    assert res[0].counted_reason == "first"
    assert res[1].counted is False
    assert res[1].counted_reason == "duplicate"
    assert is_counted(res[0]) is True
    assert is_counted(res[1]) is False


def test_dedupe_outside_window(profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a)
    e2 = make_event(id="e2", t=191.0, type="assist_elim", name_sig=sig_a)
    res = derive([e1, e2], [], profile)
    assert len(res) == 2
    assert res[0].counted is True
    assert res[0].counted_reason == "first"
    assert res[1].counted is True
    assert res[1].counted_reason == "first"


def test_different_enemy_both_counted(profile):
    sig_a = make_sig(1)
    sig_b = make_sig(2)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a)
    e2 = make_event(id="e2", t=110.0, type="assist_elim", name_sig=sig_b)
    res = derive([e1, e2], [], profile)
    assert len(res) == 2
    assert res[0].counted is True
    assert res[0].counted_reason == "first"
    assert res[1].counted is True
    assert res[1].counted_reason == "first"


def test_deleted_first_promotes_next(profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a, deleted=True)
    e2 = make_event(id="e2", t=120.0, type="assist_elim", name_sig=sig_a)
    res = derive([e1, e2], [], profile)
    assert len(res) == 2
    assert res[0].counted is False
    assert res[0].counted_reason == "deleted"
    assert res[1].counted is True
    assert res[1].counted_reason == "first"
    assert is_counted(res[0]) is False
    assert is_counted(res[1]) is True


def test_override_respected(profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a, counted_override=False)
    res = derive([e1], [], profile)
    assert len(res) == 1
    assert res[0].counted is True
    assert res[0].counted_reason == "first"
    assert res[0].counted_override is False
    assert is_counted(res[0]) is False


def test_manual_event_without_sig_counted(profile):
    e1 = make_event(id="m1", t=100.0, type="knock", name_sig=None, source="manual")
    e2 = make_event(id="m2", t=120.0, type="knock", name_sig=None, source="manual")
    res = derive([e1, e2], [], profile)
    assert len(res) == 2
    assert res[0].counted is True
    assert res[0].counted_reason == "first"
    assert res[1].counted is True
    assert res[1].counted_reason == "first"


def test_sig_similar():
    sig_a = make_sig(1, width=60)
    sig_b = make_sig(2, width=60)
    assert sig_similar(None, None, 0.32) is False
    assert sig_similar(sig_a, None, 0.32) is False
    assert sig_similar(None, sig_b, 0.32) is False
    assert sig_similar(sig_a, sig_a, 0.32) is True
    assert sig_similar(sig_a, sig_b, 0.32) is False

    # Width difference >= 15%: (60 - 48) / 60 = 0.20 >= 0.15.
    bits48 = np.ones((16, 48), dtype=np.uint8)
    sig48 = NameSig(48, bits48).to_b64()
    bits60 = np.ones((16, 60), dtype=np.uint8)
    sig60 = NameSig(60, bits60).to_b64()
    assert sig_similar(sig48, sig60, 0.32) is False


def test_derive_sorts_and_immutability(profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=200.0, type="knock", name_sig=sig_a)
    e2 = make_event(id="e2", t=100.0, type="knock", name_sig=sig_a)
    res = derive([e1, e2], [], profile)
    assert [e.id for e in res] == ["e2", "e1"]
    # The original object is immutable.
    assert e1.counted is False
    assert e1.counted_reason == ""
    assert e2.counted is False
    assert e2.counted_reason == ""


def test_spectating_boundaries(profile):
    sig_a = make_sig(1)
    spec = [SpecInterval(start=10.0, end=20.0)]
    e_before = make_event(id="e1", t=9.99, type="knock", name_sig=sig_a)
    e_start = make_event(id="e2", t=10.0, type="knock", name_sig=sig_a)
    e_inside = make_event(id="e3", t=19.99, type="knock", name_sig=sig_a)
    e_end = make_event(id="e4", t=20.0, type="knock", name_sig=sig_a)

    res = derive([e_before, e_start, e_inside, e_end], spec, profile)
    assert res[0].counted_reason == "first"
    assert res[1].counted_reason == "spectating"
    assert res[2].counted_reason == "spectating"
    # e_end is at 20.0, which is outside spectating [10, 20), but within dedupe_window (20 - 9.99 = 10.01 <= 90) of e_before
    assert res[3].counted_reason == "duplicate"


def test_squad_wipe_never_acts_as_dedupe_first(profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="squad_wipe", name_sig=sig_a)
    e2 = make_event(id="e2", t=110.0, type="knock", name_sig=sig_a)
    res = derive([e1, e2], [], profile)
    assert res[0].counted is False
    assert res[0].counted_reason == "not_counting_type"
    assert res[1].counted is True
    assert res[1].counted_reason == "first"


def test_is_counted_deleted():
    e_del_override = make_event(deleted=True, counted_override=True, counted=True)
    assert is_counted(e_del_override) is False

    e_del_no_override = make_event(deleted=True, counted=True)
    assert is_counted(e_del_no_override) is False


def test_dedupe_window_is_inclusive_and_duplicates_do_not_extend_it(profile):
    sig_a = make_sig(1)
    times = [0.0, 45.0, 90.0, 90.25, 180.25, 180.5]
    events = [make_event(id=str(i), t=t, name_sig=sig_a) for i, t in enumerate(times)]
    result = derive(list(reversed(events)), [], profile)
    assert [e.counted_reason for e in result] == [
        "first", "duplicate", "duplicate", "first", "duplicate", "first",
    ]


def test_dedupe_matches_similar_but_different_encoded_signatures(profile):
    sig_a = make_sig(1)
    changed = NameSig.from_b64(sig_a)
    changed.bits[4, 10:15] ^= 1
    sig_b = changed.to_b64()
    assert sig_a != sig_b
    events = [make_event(id="a", t=0.0, name_sig=sig_a),
              make_event(id="b", t=1.0, name_sig=sig_b),
              make_event(id="c", t=91.0, name_sig=sig_b)]
    assert [e.counted_reason for e in derive(events, [], profile)] == ["first", "duplicate", "first"]


def test_invalid_signatures_do_not_dedupe_or_block_valid_events(profile):
    signatures = [None, "", "bad", "60:AA==", [], {}, make_sig(1), make_sig(1)]
    events = [make_event(id=str(i), t=float(i), name_sig=value) for i, value in enumerate(signatures)]
    assert [e.counted_reason for e in derive(events, [], profile)] == ["first"] * 7 + ["duplicate"]


def test_repeated_signatures_are_decoded_once_per_derivation(profile, monkeypatch):
    sig_a = make_sig(1)
    decode = NameSig.from_b64
    calls = []

    def tracked(cls, value):
        calls.append(value)
        return decode(value)

    monkeypatch.setattr(NameSig, "from_b64", classmethod(tracked))
    events = [make_event(id=str(i), t=i * 0.25, name_sig=sig_a) for i in range(20)]
    for _ in range(2):
        result = derive(events, [], profile)
        assert [e.counted for e in result] == [True] + [False] * 19
    assert calls == [sig_a, sig_a]
