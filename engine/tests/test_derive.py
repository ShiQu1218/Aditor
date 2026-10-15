import numpy as np
import pytest

from apexhl.derive import derive, is_counted, sig_similar
from apexhl.models import Event, NameSig, SpecInterval


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


def test_squad_wipe_not_counted(zh_profile):
    e = make_event(id="e1", t=50.0, type="squad_wipe", name_sig=make_sig(1))
    res = derive([e], [], zh_profile)
    assert len(res) == 1
    assert res[0].counted is False
    assert res[0].counted_reason == "not_counting_type"
    assert is_counted(res[0]) is False


def test_spectating_not_counted(zh_profile):
    e = make_event(id="e1", t=50.0, type="knock", name_sig=make_sig(1))
    spec = [SpecInterval(start=40.0, end=60.0)]
    res = derive([e], spec, zh_profile)
    assert len(res) == 1
    assert res[0].counted is False
    assert res[0].counted_reason == "spectating"
    assert is_counted(res[0]) is False


def test_dedupe_same_enemy_within_window(zh_profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a)
    e2 = make_event(id="e2", t=180.0, type="assist_elim", name_sig=sig_a)
    res = derive([e1, e2], [], zh_profile)
    assert len(res) == 2
    assert res[0].counted is True
    assert res[0].counted_reason == "first"
    assert res[1].counted is False
    assert res[1].counted_reason == "duplicate"
    assert is_counted(res[0]) is True
    assert is_counted(res[1]) is False


def test_dedupe_outside_window(zh_profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a)
    e2 = make_event(id="e2", t=191.0, type="assist_elim", name_sig=sig_a)
    res = derive([e1, e2], [], zh_profile)
    assert len(res) == 2
    assert res[0].counted is True
    assert res[0].counted_reason == "first"
    assert res[1].counted is True
    assert res[1].counted_reason == "first"


def test_different_enemy_both_counted(zh_profile):
    sig_a = make_sig(1)
    sig_b = make_sig(2)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a)
    e2 = make_event(id="e2", t=110.0, type="assist_elim", name_sig=sig_b)
    res = derive([e1, e2], [], zh_profile)
    assert len(res) == 2
    assert res[0].counted is True
    assert res[0].counted_reason == "first"
    assert res[1].counted is True
    assert res[1].counted_reason == "first"


def test_deleted_first_promotes_next(zh_profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a, deleted=True)
    e2 = make_event(id="e2", t=120.0, type="assist_elim", name_sig=sig_a)
    res = derive([e1, e2], [], zh_profile)
    assert len(res) == 2
    assert res[0].counted is False
    assert res[0].counted_reason == "deleted"
    assert res[1].counted is True
    assert res[1].counted_reason == "first"
    assert is_counted(res[0]) is False
    assert is_counted(res[1]) is True


def test_override_respected(zh_profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="knock", name_sig=sig_a, counted_override=False)
    res = derive([e1], [], zh_profile)
    assert len(res) == 1
    assert res[0].counted is True
    assert res[0].counted_reason == "first"
    assert res[0].counted_override is False
    assert is_counted(res[0]) is False


def test_manual_event_without_sig_counted(zh_profile):
    e1 = make_event(id="m1", t=100.0, type="knock", name_sig=None, source="manual")
    e2 = make_event(id="m2", t=120.0, type="knock", name_sig=None, source="manual")
    res = derive([e1, e2], [], zh_profile)
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

    # 寬度差 >= 15%：(60 - 48) / 60 = 0.20 >= 0.15
    bits48 = np.ones((16, 48), dtype=np.uint8)
    sig48 = NameSig(48, bits48).to_b64()
    bits60 = np.ones((16, 60), dtype=np.uint8)
    sig60 = NameSig(60, bits60).to_b64()
    assert sig_similar(sig48, sig60, 0.32) is False


def test_derive_sorts_and_immutability(zh_profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=200.0, type="knock", name_sig=sig_a)
    e2 = make_event(id="e2", t=100.0, type="knock", name_sig=sig_a)
    res = derive([e1, e2], [], zh_profile)
    assert [e.id for e in res] == ["e2", "e1"]
    # 原始物件不可變
    assert e1.counted is False
    assert e1.counted_reason == ""
    assert e2.counted is False
    assert e2.counted_reason == ""


def test_spectating_boundaries(zh_profile):
    sig_a = make_sig(1)
    spec = [SpecInterval(start=10.0, end=20.0)]
    e_before = make_event(id="e1", t=9.99, type="knock", name_sig=sig_a)
    e_start = make_event(id="e2", t=10.0, type="knock", name_sig=sig_a)
    e_inside = make_event(id="e3", t=19.99, type="knock", name_sig=sig_a)
    e_end = make_event(id="e4", t=20.0, type="knock", name_sig=sig_a)

    res = derive([e_before, e_start, e_inside, e_end], spec, zh_profile)
    assert res[0].counted_reason == "first"
    assert res[1].counted_reason == "spectating"
    assert res[2].counted_reason == "spectating"
    # e_end is at 20.0, which is outside spectating [10, 20), but within dedupe_window (20 - 9.99 = 10.01 <= 90) of e_before
    assert res[3].counted_reason == "duplicate"


def test_squad_wipe_never_acts_as_dedupe_first(zh_profile):
    sig_a = make_sig(1)
    e1 = make_event(id="e1", t=100.0, type="squad_wipe", name_sig=sig_a)
    e2 = make_event(id="e2", t=110.0, type="knock", name_sig=sig_a)
    res = derive([e1, e2], [], zh_profile)
    assert res[0].counted is False
    assert res[0].counted_reason == "not_counting_type"
    assert res[1].counted is True
    assert res[1].counted_reason == "first"


def test_is_counted_deleted():
    e_del_override = make_event(deleted=True, counted_override=True, counted=True)
    assert is_counted(e_del_override) is False

    e_del_no_override = make_event(deleted=True, counted=True)
    assert is_counted(e_del_no_override) is False
