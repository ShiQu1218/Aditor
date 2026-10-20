"""C1: Merge event ownership across parallel segments and resumed analysis.

Drive the real analyze/EventTracker/derive pipeline with synthetic per-frame detections (fake FrameStream and Detector).
Place repeat knockdowns of the same enemy (deduplicated by derive) and banners across segment boundaries, and require every jobs result to match jobs=1 event by event.
"""
import threading

import numpy as np
import pytest

from aditor import analyze as az
from aditor.cache import cache_path, load_cache
from aditor.icon_detect import IconFrame
from aditor.models import FrameResult, NameSig
from conftest import make_video

DURATION = 60.0
STEP = 0.25


def _sig(seed: int, width: int = 60) -> NameSig:
    rng = np.random.default_rng(seed)
    return NameSig(width, (rng.random((16, width)) > 0.5).astype(np.uint8))


def _build_script():
    """{frame index: FrameResult}. For each enemy, first record a knock with a readable name, then a later knock on the same enemy (same name, marked duplicate by derive)."""
    script: dict[int, FrameResult] = {}

    def put(t0, t1, kind, namer):
        i0, i1 = int(round(t0 / STEP)), int(round(t1 / STEP))
        for i in range(i0, i1):
            script[i] = FrameResult(kind, 0.9, 0, False, namer(i), False)

    def knock(t0, t1, seed):
        put(t0, t1, "knock", lambda i, s=_sig(seed): s)

    def reknock(t0, t1, seed):
        put(t0, t1, "knock", lambda i, s=_sig(seed): s)

    # Timeline (seconds). Segment boundaries: jobs=2 → 30; jobs=3 → 20, 40; jobs=4 → 15, 30, 45.
    # Each group contains a knock and a later knock on the same enemy, deliberately placed on opposite sides of a boundary.
    for n, (k0, k1, e0, e1) in enumerate([
            (5.0, 7.5, 9.0, 11.0),       # Not near a segment boundary.
            (12.5, 14.5, 16.0, 18.0),    # Knock before 15, follow-up after 15.
            (19.0, 21.5, 23.0, 25.0),    # The knock itself crosses 20.
            (26.0, 28.5, 31.0, 33.0),    # Knock before 30, follow-up after 30.
            (36.0, 38.0, 41.0, 43.0),    # Knock before 40, follow-up after 40.
            (44.0, 46.5, 48.0, 50.0),    # Knock crosses 45.
            (55.0, 57.0, 58.0, 59.75)]):  # Near the end of the video.
        knock(k0, k1, 100 + n)
        reknock(e0, e1, 100 + n)
    put(51.0, 53.0, "assist_elim", lambda i: None)  # Assist-elim has no name fingerprint, so it is not deduplicated.
    return script


class _FakeStream:
    def __init__(self, script, duration):
        self.script, self.duration = script, duration

    def __call__(self, path, profile, *, start=0.0, hwaccel=True, codec=None, end=None):
        stop = self.duration if end is None else min(end, self.duration)
        t = start
        k = 0

        class S:
            def __iter__(s):
                nonlocal k
                while start + k * STEP < stop - 1e-9:
                    yield start + k * STEP, start + k * STEP, None
                    k += 1

            def close(s):
                pass
        return S()


class _FakeDetector:
    script: dict = {}

    def __init__(self, profile, icon_scale=1.0, keywords=None):
        pass

    def detect(self, banner, spec):
        i = int(round(banner / STEP))
        return self.script.get(i, FrameResult(None, 0.0, 0, False, None, False))

    def prepare(self, banner, spec):
        return self.detect(banner, spec), IconFrame()

    def resolve(self, r):
        return r

    def set_keywords(self, keywords):
        pass


@pytest.fixture
def fake_env(tmp_path, profile, monkeypatch):
    script = _build_script()
    _FakeDetector.script = script
    v = make_video(tmp_path, "plain.mp4", int(DURATION))
    monkeypatch.setattr(az, "FrameStream", _FakeStream(script, DURATION))
    monkeypatch.setattr(az, "Detector", _FakeDetector)
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: 1.0)
    monkeypatch.setattr(az, "LEARN_SCAN_SECONDS", 0.0)  # Synthetic frames have no anchors to learn from; do not learn keywords.
    monkeypatch.setattr(az, "EXTEND_LEARNING", False)
    return v, profile, tmp_path


def _view(doc):
    return [(e["id"], e["t"], e["type"], e["name_sig"], e["counted"], e["counted_reason"])
            for e in doc["events"]]


def test_single_segment_baseline_counts_each_enemy_once(fake_env):
    v, prof, tmp = fake_env
    doc = az.analyze(str(v), prof, cache_dir=tmp / "c1", jobs=1)
    counted = [e for e in doc["events"] if e["counted"]]
    # Count each of 7 enemies once (duplicate knocks are deduplicated) plus 1 assist-elim.
    assert len(counted) == 8, _view(doc)
    assert sum(1 for e in doc["events"] if e["counted_reason"] == "duplicate") == 7


@pytest.mark.parametrize("jobs", [2, 3, 4])
def test_segmented_events_identical_to_single(fake_env, jobs):
    v, prof, tmp = fake_env
    single = az.analyze(str(v), prof, cache_dir=tmp / "c1", jobs=1)
    seg = az.analyze(str(v), prof, cache_dir=tmp / f"c{jobs}", jobs=jobs)
    assert _view(seg) == _view(single)
    assert sum(e["counted"] for e in seg["events"]) == sum(e["counted"] for e in single["events"]) == 8


def test_spectating_intervals_identical_across_jobs(tmp_path, profile, monkeypatch):
    script = {i: FrameResult(None, 0.0, 0, False, None, True) for i in range(int(18 / STEP), int(33 / STEP))}
    _FakeDetector.script = script
    v = make_video(tmp_path, "plain.mp4", int(DURATION))
    monkeypatch.setattr(az, "FrameStream", _FakeStream(script, DURATION))
    monkeypatch.setattr(az, "Detector", _FakeDetector)
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: 1.0)
    monkeypatch.setattr(az, "LEARN_SCAN_SECONDS", 0.0)
    monkeypatch.setattr(az, "EXTEND_LEARNING", False)
    one = az.analyze(str(v), profile, cache_dir=tmp_path / "a", jobs=1)["spectating"]
    four = az.analyze(str(v), profile, cache_dir=tmp_path / "b", jobs=4)["spectating"]
    assert one == four and len(one) == 1


def test_resume_after_cancel_equals_uninterrupted(fake_env, monkeypatch):
    """Resuming after cancellation (rebuilding context before each segment's owned range) matches uninterrupted output item by item, with no duplicate counts."""
    v, prof, tmp = fake_env
    full = az.analyze(str(v), prof, cache_dir=tmp / "full", jobs=1)
    for jobs, stop_at in ((1, 26.0), (1, 31.5), (1, 44.0), (3, 36.0)):
        cache = tmp / f"r{jobs}_{stop_at}"
        cancel = threading.Event()
        inner = _FakeStream(_FakeDetector.script, DURATION)

        def cancelling(*a, _inner=inner, _cancel=cancel, _stop=stop_at, **k):
            it = _inner(*a, **k)

            class W:
                def __iter__(s):
                    for t, b, sp in it:
                        if t >= _stop and (jobs == 1 or k.get("end") == 52.0):  # For jobs=3, trigger cancellation only in segment 2 (20–40 + post-roll).
                            _cancel.set()
                        yield t, b, sp

                def close(s):
                    it.close()
            return W()

        with monkeypatch.context() as m:
            m.setattr(az, "FrameStream", cancelling)
            with pytest.raises(az.Cancelled):
                az.analyze(str(v), prof, cache_dir=cache, cancel=cancel, jobs=jobs)
        part = load_cache(cache_path(str(v), cache))
        assert part["analysis"]["status"] == "partial"
        done = az.analyze(str(v), prof, cache_dir=cache, jobs=jobs)
        assert _view(done) == _view(full), (jobs, stop_at)
