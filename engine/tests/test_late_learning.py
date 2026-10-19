"""延伸學習：影片開頭（學習範圍）幾乎沒有擊殺、關鍵字樣板學不齊時，繼續往後蒐集錨點補上缺的樣板，
並用學到的樣板重新定案整支影片（離線不重新解碼、即時不吃光記憶體），結果與 jobs、離線／即時無關。

用合成的逐格結果驅動真的 analyze／LiveKills／EventTracker／derive：假偵測器把「真擊倒」與「長得像擊倒的
非擊殺橫幅（例如敵方小隊已消滅）」都產出待驗證格；有擊倒樣板時非擊殺橫幅被擋掉，沒有樣板時兩者都算擊倒。
假收集器把真擊倒當錨點，假 build_keywords 在 ≥ 3 個不同橫幅時學出擊倒樣板。"""
import threading
from types import SimpleNamespace

import numpy as np
import pytest

from aditor import analyze as az
from aditor import live as lv
from aditor.cache import cache_path, load_cache
from aditor.calibrate import BANNER_GAP, extend_keywords, keywords_complete, same_keywords
from aditor.detect import Keywords, Pending
from aditor.icon_detect import IconFrame
from aditor.models import FrameResult
from conftest import make_video

STEP = 0.25
DURATION = 60.0
LEARN = 10.0          # 測試用學習範圍（正式為 900 秒）
TPL = np.ones((2, 2), np.float32)


def _script(kills, fakes):
    s = {}
    for kind, spans in (("kill", kills), ("fake", fakes)):
        for t0, t1 in spans:
            for i in range(int(round(t0 / STEP)), int(round(t1 / STEP))):
                s[i] = kind
    return s


# 開頭 10 秒只有一個非擊殺橫幅；真擊倒都在學習範圍之後；結尾前還有一個非擊殺橫幅
LATE = _script(kills=[(14.0, 16.0), (22.0, 24.0), (31.0, 33.0), (41.0, 43.0)], fakes=[(4.0, 6.0), (50.0, 52.0)])
# 對照：真擊倒都在學習範圍內
EARLY = _script(kills=[(0.5, 1.5), (4.0, 5.0), (7.5, 8.5)], fakes=[(20.0, 22.0), (50.0, 52.0)])


class _FakeStream:
    def __init__(self, duration):
        self.duration = duration

    def __call__(self, path, profile, *, start=0.0, hwaccel=True, codec=None, end=None):
        stop = self.duration if end is None else min(end, self.duration)

        class S:
            def __iter__(s):
                k = 0
                while start + k * STEP < stop - 1e-9:
                    yield start + k * STEP, start + k * STEP, None
                    k += 1

            def close(s):
                pass
        return S()


class _FakeDetector:
    script: dict = {}

    def __init__(self, profile, icon_scale=1.0, keywords=None, params=None):
        self.set_keywords(keywords)

    def set_keywords(self, keywords):
        self.keywords = keywords if keywords is not None and not keywords.empty else None

    def prepare(self, banner, spec):
        kind = self.script.get(int(round(banner / STEP)))
        if kind is None:
            return FrameResult(None, 0.0, 0, False, None, False), IconFrame()
        return Pending(kind, IconFrame(), np.zeros((4, 4), np.uint8), None, False), IconFrame()

    def resolve(self, r):
        if isinstance(r, FrameResult):
            return r
        if r.kind == "fake" and self.keywords is not None and self.keywords.knock is not None:
            return FrameResult(None, 0.0, 0, False, None, False)
        return FrameResult("knock", 0.9, 0, True, None, False)


class _FakeCollector:
    """真擊倒的畫格當錨點（相隔 > BANNER_GAP 秒算不同橫幅）。"""
    script: dict = {}

    def __init__(self, profile, det):
        self.knock = SimpleNamespace(groups=[])
        self.hand = SimpleNamespace(groups=[])

    def feed_features(self, t, banner, f):
        if self.script.get(int(round(banner / STEP))) != "kill":
            return
        g = self.knock.groups
        if g and t - g[-1][1] <= BANNER_GAP:
            g[-1] = (g[-1][0], t, g[-1][2])
        else:
            g.append((t, t, []))

    def full(self, t):
        return False


def _fake_build(cols):
    starts = sorted(t0 for c in cols for t0, _, _ in c.knock.groups)
    merged = [t for i, t in enumerate(starts) if i == 0 or t - starts[i - 1] > BANNER_GAP]
    return Keywords(None, TPL.copy() if len(merged) >= 3 else None)


@pytest.fixture
def fake_env(tmp_path, profile, monkeypatch):
    def use(script):
        _FakeDetector.script = _FakeCollector.script = script
    use(LATE)
    v = make_video(tmp_path, "plain.mp4", int(DURATION))
    for mod in (az, lv):
        monkeypatch.setattr(mod, "Detector", _FakeDetector)
        monkeypatch.setattr(mod, "AnchorCollector", _FakeCollector)
        monkeypatch.setattr(mod, "build_keywords", _fake_build)
    monkeypatch.setattr(az, "FrameStream", _FakeStream(DURATION))
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: 1.0)
    monkeypatch.setattr(az, "LEARN_SCAN_SECONDS", LEARN)
    return SimpleNamespace(video=v, profile=profile, tmp=tmp_path, use=use)


def _knocks(events):
    return [(e["type"] if isinstance(e, dict) else e.type, e["t"] if isinstance(e, dict) else e.t)
            for e in events]


# ---- 純函式 ----

def test_extend_keeps_head_templates_and_only_fills_missing_ones():
    head_k, wide_k, wide_a = TPL, TPL * 0.5, TPL * 0.2
    base = Keywords(None, head_k, True)
    out = extend_keywords(base, Keywords(wide_a, wide_k, False))
    assert out.knock is head_k and out.assist is wide_a and out.assist_by_knock is True
    out = extend_keywords(Keywords(), Keywords(wide_a, wide_k, True))
    assert out.knock is wide_k and out.assist_by_knock is True
    assert keywords_complete(Keywords(TPL, TPL)) and not keywords_complete(Keywords(None, TPL))
    # 助攻消滅本來就少見：助攻橫幅含擊倒關鍵字（中文、英文）時，只有擊倒樣板也能驗證所有類別，不需要延伸學習
    assert keywords_complete(Keywords(None, TPL, assist_by_knock=True))
    assert not keywords_complete(Keywords(TPL, None, assist_by_knock=True))
    assert same_keywords(Keywords(None, TPL), Keywords(None, TPL.copy()))
    assert not same_keywords(Keywords(None, TPL), Keywords())


# ---- 離線 ----

def test_offline_learns_after_head_and_rejects_lookalike_banners(fake_env):
    doc = az.analyze(str(fake_env.video), fake_env.profile, cache_dir=fake_env.tmp / "c", jobs=1)
    assert _knocks(doc["events"]) == [("knock", 14.0), ("knock", 22.0), ("knock", 31.0), ("knock", 41.0)]
    assert doc["analysis"]["keywords"]["knock"] is not None


def test_offline_head_learning_unchanged_when_head_has_kills(fake_env):
    fake_env.use(EARLY)
    doc = az.analyze(str(fake_env.video), fake_env.profile, cache_dir=fake_env.tmp / "c", jobs=1)
    assert _knocks(doc["events"]) == [("knock", 0.5), ("knock", 4.0), ("knock", 7.5)]


@pytest.mark.parametrize("jobs", [2, 3, 4])
def test_offline_late_learning_independent_of_jobs(fake_env, jobs):
    one = az.analyze(str(fake_env.video), fake_env.profile, cache_dir=fake_env.tmp / "one", jobs=1)
    many = az.analyze(str(fake_env.video), fake_env.profile, cache_dir=fake_env.tmp / f"j{jobs}", jobs=jobs)
    assert _knocks(many["events"]) == _knocks(one["events"])
    assert many["analysis"]["keywords"] == one["analysis"]["keywords"]


def test_offline_too_few_kills_anywhere_falls_back_to_icons(fake_env):
    fake_env.use(_script(kills=[(20.0, 22.0), (30.0, 32.0)], fakes=[(4.0, 6.0)]))
    doc = az.analyze(str(fake_env.video), fake_env.profile, cache_dir=fake_env.tmp / "c", jobs=2)
    assert _knocks(doc["events"]) == [("knock", 4.0), ("knock", 20.0), ("knock", 30.0)]
    assert "keywords" not in doc["analysis"] or doc["analysis"]["keywords"]["knock"] is None


def test_cancel_while_late_learning_saves_only_calibration_and_resume_matches(fake_env, monkeypatch):
    full = az.analyze(str(fake_env.video), fake_env.profile, cache_dir=fake_env.tmp / "full", jobs=1)
    cache = fake_env.tmp / "part"
    cancel = threading.Event()
    inner = _FakeStream(DURATION)

    def cancelling(*a, **k):
        it = inner(*a, **k)

        class W:
            def __iter__(s):
                for t, b, sp in it:
                    if t >= 45.0:  # 延伸學習進行中（學習範圍 10 秒早已結束）
                        cancel.set()
                    yield t, b, sp

            def close(s):
                it.close()
        return W()

    with monkeypatch.context() as m:
        m.setattr(az, "FrameStream", cancelling)
        with pytest.raises(az.Cancelled):
            az.analyze(str(fake_env.video), fake_env.profile, cache_dir=cache, cancel=cancel, jobs=1)
    part = load_cache(cache_path(str(fake_env.video), cache))
    assert part["analysis"]["status"] == "partial" and part["events"] == []
    assert "keywords" not in part["analysis"]  # 未定案的樣板不寫入：接續時重新學（含延伸學習）
    done = az.analyze(str(fake_env.video), fake_env.profile, cache_dir=cache, jobs=1)
    assert _knocks(done["events"]) == _knocks(full["events"])


# ---- 即時 ----

class _FakeCalibration:
    def __init__(self, profile, max_scan, max_bytes):
        self.hits, self.frames, self.bytes, self.max_bytes, self.scanned = [], [], 0, max_bytes, 0.0

    def feed(self, t, banner, spec):
        return True


@pytest.fixture
def live_env(fake_env, monkeypatch):
    monkeypatch.setattr(lv, "_Calibration", _FakeCalibration)
    return fake_env


def _run_live(kills, duration=DURATION, upto=None):
    k = 0
    while k * STEP < (upto if upto is not None else duration) - 1e-9:
        t = k * STEP
        kills.feed(t, t, None)
        k += 1


def test_live_matches_offline_with_late_learning(live_env):
    doc = az.analyze(str(live_env.video), live_env.profile, cache_dir=live_env.tmp / "c", jobs=1)
    kills = lv.LiveKills(live_env.profile, learn_seconds=LEARN)
    _run_live(kills)
    events, _ = kills.finish()
    assert _knocks(events) == _knocks(doc["events"])
    assert kills.degraded == []


def test_live_snapshot_drops_lookalike_once_learned_mid_stream(live_env):
    kills = lv.LiveKills(live_env.profile, learn_seconds=LEARN)
    _run_live(kills, upto=20.0)
    assert ("knock", 4.0) in _knocks(kills.snapshot()[0])  # 只學到 1 個橫幅：非擊殺橫幅暫時算擊倒
    _run_live_from(kills, 20.0, 36.0)  # 第 3 個真擊倒（31–33 秒）之後學到擊倒樣板 → 立刻重新定案
    assert _knocks(kills.snapshot()[0]) == [("knock", 14.0), ("knock", 22.0), ("knock", 31.0)]


def test_live_late_learning_memory_cap_degrades_without_crashing(live_env):
    logs = []
    kills = lv.LiveKills(live_env.profile, learn_seconds=LEARN, late_max_bytes=1, log=logs.append)
    _run_live(kills)
    events, _ = kills.finish()
    assert "late_learn_cap" in kills.degraded
    assert any("延伸學習" in m for m in logs)
    assert len(events) >= 4


def _run_live_from(kills, start, end):
    k = 0
    while start + k * STEP < end - 1e-9:
        t = start + k * STEP
        kills.feed(t, t, None)
        k += 1
