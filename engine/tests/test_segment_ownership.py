"""C1：切段平行／接續的事件「擁有權」合併。

用合成的逐格偵測結果（假 FrameStream＋假 Detector）驅動真的 analyze／EventTracker／derive，
重現「同敵人補刀的指紋被連結改寫 → 跨段去重失敗 → 多算」，並要求任何 jobs 的結果與 jobs=1 逐筆相同。
"""
import threading

import numpy as np
import pytest

from apexhl import analyze as az
from apexhl.cache import cache_path, load_cache
from apexhl.models import FrameResult, NameSig
from conftest import make_video

DURATION = 60.0
STEP = 0.25


def _sig(seed: int, width: int = 60) -> NameSig:
    rng = np.random.default_rng(seed)
    return NameSig(width, (rng.random((16, width)) > 0.5).astype(np.uint8))


def _build_script():
    """{格索引: FrameResult}。每個敵人：擊倒讀得到名字，補刀的名字全是互不相干的殘片（只能靠時間配對）。"""
    script: dict[int, FrameResult] = {}

    def put(t0, t1, kind, namer):
        i0, i1 = int(round(t0 / STEP)), int(round(t1 / STEP))
        for i in range(i0, i1):
            script[i] = FrameResult(kind, 0.9, 0, False, namer(i), False)

    def knock(t0, t1, seed):
        put(t0, t1, "knock", lambda i, s=_sig(seed): s)

    def elim(t0, t1):
        put(t0, t1, "elim", lambda i: _sig(10_000 + i))

    # 時間軸（秒）。段界：jobs=2 → 30；jobs=3 → 20、40；jobs=4 → 15、30、45。
    # 每組：擊倒讀得到名字；同敵人的補刀名字全是殘片（只能靠時間配對／連結），位置刻意跨在段界兩側。
    for n, (k0, k1, e0, e1) in enumerate([
            (5.0, 7.5, 9.0, 11.0),       # 不靠近任何段界
            (12.5, 14.5, 16.0, 18.0),    # 擊倒在 15 前、補刀在 15 後
            (19.0, 21.5, 23.0, 25.0),    # 擊倒本身跨過 20
            (26.0, 28.5, 31.0, 33.0),    # 擊倒在 30 前、補刀在 30 後
            (36.0, 38.0, 41.0, 43.0),    # 擊倒在 40 前、補刀在 40 後
            (44.0, 46.5, 48.0, 50.0),    # 擊倒跨過 45
            (55.0, 57.0, 58.0, 59.75)]):  # 近片尾
        knock(k0, k1, 100 + n)
        elim(e0, e1)
    put(51.0, 53.0, "elim", lambda i, s=_sig(400): s)  # 另一個獨立擊殺（無擊倒）
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

    def __init__(self, profile, h_scale=1.0):
        pass

    def detect(self, banner, spec):
        i = int(round(banner / STEP))
        return self.script.get(i, FrameResult(None, 0.0, 0, False, None, False))


@pytest.fixture
def fake_env(tmp_path, zh_profile, monkeypatch):
    script = _build_script()
    _FakeDetector.script = script
    v = make_video(tmp_path, "plain.mp4", int(DURATION))
    monkeypatch.setattr(az, "FrameStream", _FakeStream(script, DURATION))
    monkeypatch.setattr(az, "Detector", _FakeDetector)
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: 1.0)
    return v, zh_profile, tmp_path


def _view(doc):
    return [(e["id"], e["t"], e["type"], e["name_sig"], e["counted"], e["counted_reason"])
            for e in doc["events"]]


def test_single_segment_baseline_counts_each_enemy_once(fake_env):
    v, prof, tmp = fake_env
    doc = az.analyze(str(v), prof, cache_dir=tmp / "c1", jobs=1)
    counted = [e for e in doc["events"] if e["counted"]]
    # 7 個有擊倒的敵人（補刀被併入）＋ 1 個獨立擊殺
    assert len(counted) == 8, _view(doc)
    assert sum(1 for e in doc["events"] if e["type"] == "elim" and not e["counted"]) == 7


@pytest.mark.parametrize("jobs", [2, 3, 4])
def test_segmented_events_identical_to_single(fake_env, jobs):
    v, prof, tmp = fake_env
    single = az.analyze(str(v), prof, cache_dir=tmp / "c1", jobs=1)
    seg = az.analyze(str(v), prof, cache_dir=tmp / f"c{jobs}", jobs=jobs)
    assert _view(seg) == _view(single)
    assert sum(e["counted"] for e in seg["events"]) == sum(e["counted"] for e in single["events"]) == 8


def test_spectating_intervals_identical_across_jobs(tmp_path, zh_profile, monkeypatch):
    script = {i: FrameResult(None, 0.0, 0, False, None, True) for i in range(int(18 / STEP), int(33 / STEP))}
    _FakeDetector.script = script
    v = make_video(tmp_path, "plain.mp4", int(DURATION))
    monkeypatch.setattr(az, "FrameStream", _FakeStream(script, DURATION))
    monkeypatch.setattr(az, "Detector", _FakeDetector)
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: 1.0)
    one = az.analyze(str(v), zh_profile, cache_dir=tmp_path / "a", jobs=1)["spectating"]
    four = az.analyze(str(v), zh_profile, cache_dir=tmp_path / "b", jobs=4)["spectating"]
    assert one == four and len(one) == 1


def test_resume_after_cancel_equals_uninterrupted(fake_env, monkeypatch):
    """取消後接續（每段回到擁有範圍前再補足上下文）與不中斷的結果逐筆相同，不重複計入。"""
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
                        if t >= _stop and (jobs == 1 or k.get("end") == 52.0):  # jobs=3：只讓第 2 段（20–40 + 後延）觸發取消
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
