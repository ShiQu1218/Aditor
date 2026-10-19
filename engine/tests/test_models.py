import numpy as np
import pytest

from aditor.models import Event, NameSig


def test_namesig_roundtrip():
    bits = (np.random.default_rng(0).random((16, 40)) > 0.5).astype(np.uint8)
    s = NameSig(40, bits).to_b64()
    back = NameSig.from_b64(s)
    assert back.width == 40 and np.array_equal(back.bits, bits)


def test_event_dict_roundtrip():
    e = Event(id="e1", t=812.25, type="knock", score=0.91, damage_line=True, name_sig=None)
    assert Event.from_dict(e.to_dict()) == e
    assert e.to_dict()["counted_override"] is None
