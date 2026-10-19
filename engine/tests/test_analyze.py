import threading

import pytest

from aditor import analyze as az
from aditor.cache import cache_path, load_cache, save_cache
from aditor.decode import FrameStream
from conftest import make_video

SPANS = [(2.0, 4.5), (10.0, 12.5)]


@pytest.fixture
def short_learn(monkeypatch):
    """關鍵字只從開頭 1 秒學（邊解碼邊學，學完才存段進度）：讓短合成片中途取消也能測到段進度的保存與接續。
    合成片沒有錨點可學：關掉延伸學習（延伸學習期間不存段進度，見 test_late_learning）。"""
    monkeypatch.setattr(az, "LEARN_SCAN_SECONDS", 1.0)
    monkeypatch.setattr(az, "EXTEND_LEARNING", False)


@pytest.fixture
def fixture_video(tmp_path, knock_banner_png):
    return make_video(tmp_path, "含 空白.mp4", 15, overlay=(knock_banner_png, SPANS))


def test_analyze_synthetic_no_events(tmp_path, profile):
    v = make_video(tmp_path, "plain.mp4", 6)
    doc = az.analyze(str(v), profile, cache_dir=tmp_path / "cache")
    assert doc["events"] == []
    assert doc["analysis"]["status"] == "done"
    assert doc["keyframes"] and doc["clips"] == []
    assert doc["cache_path"] == str(cache_path(str(v), tmp_path / "cache"))
    assert load_cache(cache_path(str(v), tmp_path / "cache"))["analysis"]["status"] == "done"


def test_analyze_uses_cache(tmp_path, profile, monkeypatch):
    v = make_video(tmp_path, "plain.mp4", 4)
    az.analyze(str(v), profile, cache_dir=tmp_path / "cache")

    def boom(*a, **k):
        raise AssertionError("不應解碼")
    monkeypatch.setattr(az, "FrameStream", boom)
    monkeypatch.setattr(az, "calibrate", boom)
    doc = az.analyze(str(v), profile, cache_dir=tmp_path / "cache")
    assert doc["analysis"]["status"] == "done"


class _CancelAt:
    """包住 FrameStream：產出 t >= at 的畫格前先設定 cancel。"""

    def __init__(self, at, cancel):
        self.at, self.cancel = at, cancel

    def __call__(self, *a, **k):
        inner = FrameStream(*a, **k)
        at, cancel = self.at, self.cancel

        class W:
            def __iter__(s):
                for t, b, sp in inner:
                    if t >= at:
                        cancel.set()
                    yield t, b, sp

            def close(s):
                inner.close()
        return W()


def test_cancel_writes_partial(tmp_path, profile, monkeypatch, short_learn):
    v = make_video(tmp_path, "plain.mp4", 8)
    cancel = threading.Event()
    monkeypatch.setattr(az, "FrameStream", _CancelAt(3.0, cancel))
    with pytest.raises(az.Cancelled):
        az.analyze(str(v), profile, cache_dir=tmp_path / "cache", cancel=cancel)
    doc = load_cache(cache_path(str(v), tmp_path / "cache"))
    assert doc["analysis"]["status"] == "partial"
    assert 2.0 <= doc["analysis"]["progress_t"] < 3.0


def test_resume_no_duplicates(tmp_path, profile, fixture_video, monkeypatch, short_learn):
    cache = tmp_path / "cache"
    full = az.analyze(str(fixture_video), profile, cache_dir=cache / "full")
    knocks = [e for e in full["events"] if e["type"] == "knock"]
    assert len(knocks) == 2, full["events"]

    cancel = threading.Event()
    with monkeypatch.context() as m:
        m.setattr(az, "FrameStream", _CancelAt(11.0, cancel))
        with pytest.raises(az.Cancelled):
            az.analyze(str(fixture_video), profile, cache_dir=cache, cancel=cancel)
    part = load_cache(cache_path(str(fixture_video), cache))
    assert part["analysis"]["status"] == "partial"
    assert len(part["events"]) == 2  # 第二個提示在取消前已成立

    starts = []
    real = FrameStream

    def spy(*a, **k):
        starts.append(k.get("start"))
        return real(*a, **k)
    monkeypatch.setattr(az, "FrameStream", spy)
    doc = az.analyze(str(fixture_video), profile, cache_dir=cache)
    # 擁有範圍回退 RESUME_BACK、再往前補足 PREROLL 上下文（此片很短 → 從 0 起）
    own = max(0.0, part["analysis"]["progress_t"] - az.RESUME_BACK)
    assert starts == [pytest.approx(max(0.0, own - az.SEGMENT_PREROLL))]
    ks = [e for e in doc["events"] if e["type"] == "knock"]
    assert len(ks) == 2
    assert ks[0]["t"] == pytest.approx(2.0, abs=0.3)
    assert ks[1]["t"] == pytest.approx(10.0, abs=0.3)
    assert doc["analysis"]["status"] == "done"
    assert [e["t"] for e in ks] == [e["t"] for e in knocks]


def test_reanalysis_keeps_user_state(tmp_path, profile, fixture_video):
    cache = tmp_path / "cache"
    doc = az.analyze(str(fixture_video), profile, cache_dir=cache)
    doc["events"][0]["deleted"] = True
    save_cache(cache_path(str(fixture_video), cache), doc)
    doc2 = az.analyze(str(fixture_video), profile, cache_dir=cache, force=True)
    assert doc2["events"][0]["deleted"] is True
    assert doc2["unmatched"] == []


def test_progress_throttled_and_final(tmp_path, profile):
    v = make_video(tmp_path, "plain.mp4", 6)
    calls = []
    az.analyze(str(v), profile, cache_dir=tmp_path / "cache", on_progress=lambda t, d: calls.append((t, d)))
    assert calls[-1][0] == pytest.approx(calls[-1][1])
    assert len(calls) < 6 * 4 + 2  # 少於逐格呼叫


def test_cancel_during_calibration_leaves_partial(tmp_path, profile):
    from aditor.errors import Cancelled
    assert az.Cancelled is Cancelled
    v = make_video(tmp_path, "plain.mp4", 6)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(az.Cancelled):
        az.analyze(str(v), profile, cache_dir=tmp_path / "cache", cancel=cancel)
    doc = load_cache(cache_path(str(v), tmp_path / "cache"))
    assert doc["analysis"]["status"] == "partial" and doc["analysis"]["progress_t"] == 0.0


def test_resume_after_calibration_cancel_recalibrates(tmp_path, profile, monkeypatch):
    v = make_video(tmp_path, "plain.mp4", 6)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(az.Cancelled):
        az.analyze(str(v), profile, cache_dir=tmp_path / "cache", cancel=cancel)
    calls = []
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: calls.append(1) or 0.9)
    doc = az.analyze(str(v), profile, cache_dir=tmp_path / "cache")
    assert calls == [1]
    assert doc["analysis"]["h_scale"] == 0.9 and doc["analysis"]["status"] == "done"


def test_normal_partial_resume_does_not_recalibrate(tmp_path, profile, monkeypatch, short_learn):
    v = make_video(tmp_path, "plain.mp4", 8)
    cancel = threading.Event()
    with monkeypatch.context() as m:
        m.setattr(az, "FrameStream", _CancelAt(3.0, cancel))
        m.setattr(az, "calibrate", lambda *a, **k: 0.95)
        with pytest.raises(az.Cancelled):
            az.analyze(str(v), profile, cache_dir=tmp_path / "cache", cancel=cancel)
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: pytest.fail("不應重新校準"))
    doc = az.analyze(str(v), profile, cache_dir=tmp_path / "cache")
    assert doc["analysis"]["h_scale"] == 0.95


def test_partial_with_corrupt_keywords_relearns_instead_of_crashing(tmp_path, profile, monkeypatch, short_learn):
    v = make_video(tmp_path, "plain.mp4", 8)
    cache = tmp_path / "cache"
    cancel = threading.Event()
    with monkeypatch.context() as m:
        m.setattr(az, "FrameStream", _CancelAt(3.0, cancel))
        with pytest.raises(az.Cancelled):
            az.analyze(str(v), profile, cache_dir=cache, cancel=cancel)
    cp = cache_path(str(v), cache)
    part = load_cache(cp)
    part["analysis"]["keywords"] = {"assist": {"shape": [27, 64], "q8": "AAAA"}}  # 損毀
    save_cache(cp, part)
    learned = []
    real = az._Learner
    monkeypatch.setattr(az, "_Learner", lambda *a, **k: learned.append(1) or real(*a, **k))
    doc = az.analyze(str(v), profile, cache_dir=cache)
    assert learned == [1] and doc["analysis"]["status"] == "done"
    assert doc["analysis"]["keywords"] == {"assist": None, "knock": None, "assist_by_knock": False}


def test_cancel_before_keywords_learned_keeps_only_calibration(tmp_path, profile, fixture_video, monkeypatch):
    """學習範圍（預設 900 秒）涵蓋整支短片：學完前取消 → partial 只存校準尺度；接續不重新校準，
    從頭邊解碼邊學，結果與不中斷相同。"""
    cache = tmp_path / "cache"
    full = az.analyze(str(fixture_video), profile, cache_dir=cache / "full")
    cancel = threading.Event()
    with monkeypatch.context() as m:
        m.setattr(az, "FrameStream", _CancelAt(11.0, cancel))
        m.setattr(az, "calibrate", lambda *a, **k: full["analysis"]["h_scale"])
        with pytest.raises(az.Cancelled):
            az.analyze(str(fixture_video), profile, cache_dir=cache, cancel=cancel)
    a = load_cache(cache_path(str(fixture_video), cache))["analysis"]
    assert a["status"] == "partial" and a["progress_t"] == 0.0
    assert a["h_scale"] == full["analysis"]["h_scale"] and "keywords" not in a
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: pytest.fail("不應重新校準"))
    doc = az.analyze(str(fixture_video), profile, cache_dir=cache)
    assert doc["analysis"]["status"] == "done"
    assert [(e["type"], e["t"]) for e in doc["events"]] == [(e["type"], e["t"]) for e in full["events"]]


@pytest.mark.parametrize("jobs", [1, 3])
def test_in_pass_keywords_equal_separate_learning_pass(tmp_path, profile, multi_video, monkeypatch, jobs):
    """邊解碼邊學出的關鍵字樣板與獨立掃描（calibrate.learn_keywords）相同，與 jobs 無關。"""
    from aditor.calibrate import learn_keywords
    from aditor.probe import probe
    monkeypatch.setattr(az, "LEARN_SCAN_SECONDS", 45.0)  # 學習範圍跨過 jobs=3 的段界 20、40
    doc = az.analyze(str(multi_video), profile, cache_dir=tmp_path / "c", jobs=jobs)
    sep = learn_keywords(str(multi_video), probe(str(multi_video)), profile, doc["analysis"]["h_scale"],
                         max_scan_seconds=45.0)
    assert sep.knock is not None  # 合成片的擊倒橫幅足以學出擊倒樣板，比較才有意義
    assert doc["analysis"]["keywords"] == sep.to_dict()


# ---- 切段平行解碼（jobs） ----

def test_plan_segments_overlap_and_last_segment():
    segs = az.plan_segments(60.0, 3, min_len=5.0)
    assert segs == [(0.0, 20.0), (20.0, 40.0), (40.0, 60.0)]
    sg = [az._Seg(a, b, i == 2, 60.0) for i, (a, b) in enumerate(segs)]
    assert [x.dec_end for x in sg] == [20.0 + az.SEGMENT_POSTROLL, 40.0 + az.SEGMENT_POSTROLL, None]  # 段尾後延解碼，最後一段到片尾


def test_plan_segments_boundaries_on_quarter_grid():
    segs = az.plan_segments(100.0, 3)
    assert all((a / 0.25) == pytest.approx(round(a / 0.25)) for a, _ in segs)
    assert segs[0][0] == 0.0 and segs[-1][1] == 100.0
    assert all(a[1] == b[0] for a, b in zip(segs, segs[1:]))


def test_plan_segments_short_duration_reduces_jobs_to_min_len():
    assert len(az.plan_segments(100.0, 4)) == 3      # 每段 >= 30 秒
    assert len(az.plan_segments(59.0, 4)) == 1
    assert az.plan_segments(20.0, 4) == [(0.0, 20.0)]
    assert len(az.plan_segments(300.0, 4)) == 4


def test_auto_jobs(monkeypatch):
    monkeypatch.setattr(az.os, "cpu_count", lambda: 16)
    assert az.auto_jobs(True) == 4 and az.auto_jobs(False) == 1
    monkeypatch.setattr(az.os, "cpu_count", lambda: 8)
    assert az.auto_jobs(True) == 2
    monkeypatch.setattr(az.os, "cpu_count", lambda: 2)
    assert az.auto_jobs(True) == 1
    monkeypatch.setattr(az.os, "cpu_count", lambda: None)
    assert az.auto_jobs(True) == 1


@pytest.fixture(scope="module")
def multi_video(tmp_path_factory):
    import cv2
    import numpy as np
    from conftest import FIXTURES
    d = tmp_path_factory.mktemp("multi")
    src = FIXTURES / "en" / "pos" / "knock_a002500.png"
    img = cv2.imdecode(np.fromfile(str(src), dtype=np.uint8), cv2.IMREAD_COLOR)
    ok, buf = cv2.imencode(".png", img[:180])
    png = d / "b.png"
    buf.tofile(str(png))
    # jobs=3 → 邊界 20、40；提示 (19,22) 與 (39,42) 跨邊界，(24,26) 落在重疊區
    spans = [(5.0, 7.0), (19.0, 22.0), (24.0, 26.0), (39.0, 42.0), (55.0, 57.0)]
    return make_video(d, "多段.mp4", 60, overlay=(png, spans))


def _knocks(doc):
    return [(e["type"], e["t"]) for e in doc["events"]]


def test_parallel_matches_single(tmp_path, profile, multi_video):
    single = az.analyze(str(multi_video), profile, cache_dir=tmp_path / "c1", jobs=1)
    par = az.analyze(str(multi_video), profile, cache_dir=tmp_path / "c3", jobs=3)
    a, b = _knocks(single), _knocks(par)
    assert len(a) == 5, a
    assert len(a) == len(b)
    for (ta, xa), (tb, xb) in zip(a, b):
        assert ta == tb and xa == pytest.approx(xb, abs=0.3)
    assert par["analysis"]["status"] == "done" and "segments" not in par["analysis"]


class _Seg3Harness:
    """包住 FrameStream：記錄所有串流；seg0 完成後 seg2 才觸發取消，seg1 卡到取消為止。
    各段以 end 辨識（seg0 = 20 + 後延、seg1 = 40 + 後延、seg2 = None），名目起點 0／20／40。"""

    def __init__(self, cancel):
        self.cancel = cancel
        self.inners = []
        self.calls = []
        self.seg0_done = threading.Event()

    def __call__(self, *a, **k):
        inner = FrameStream(*a, **k)
        self.inners.append(inner)
        self.calls.append((k.get("start", 0.0), k.get("end")))
        end = k.get("end")
        nominal = {20.0 + az.SEGMENT_POSTROLL: 0.0, 40.0 + az.SEGMENT_POSTROLL: 20.0, None: 40.0}[end]
        h = self

        class W:
            def __iter__(s):
                for t, b, sp in inner:
                    if nominal == 0.0:
                        yield t, b, sp
                        continue
                    if nominal >= 40 and t >= nominal + 3:
                        h.seg0_done.wait(60)
                        if t >= nominal + 5:
                            h.cancel.set()
                    elif nominal >= 20 and t >= nominal + 10:
                        for _ in range(600):
                            if h.cancel.is_set():
                                break
                            threading.Event().wait(0.1)
                    yield t, b, sp
                if nominal == 0.0:
                    h.seg0_done.set()

            def close(s):
                inner.close()
        return W()


@pytest.mark.timeout(240)
def test_parallel_cancel_leaves_segments_and_resume_reruns_only_unfinished(
        tmp_path, profile, multi_video, monkeypatch, short_learn):
    full = az.analyze(str(multi_video), profile, cache_dir=tmp_path / "full", jobs=3)
    cache = tmp_path / "cache"
    cancel = threading.Event()
    harness = _Seg3Harness(cancel)
    with monkeypatch.context() as m:
        m.setattr(az, "FrameStream", harness)
        with pytest.raises(az.Cancelled):
            az.analyze(str(multi_video), profile, cache_dir=cache, cancel=cancel, jobs=3)
    assert len(harness.inners) == 3
    assert all(i._proc is not None and i._proc.poll() is not None for i in harness.inners)  # 無殘留 ffmpeg
    part = load_cache(cache_path(str(multi_video), cache))
    a = part["analysis"]
    assert a["status"] == "partial" and len(a["segments"]) == 3
    segs = a["segments"]
    assert segs[0]["progress_t"] == pytest.approx(20.0 + az.SEGMENT_POSTROLL)  # seg0 已完成（含後延）
    assert segs[1]["progress_t"] < 40.0 + az.SEGMENT_POSTROLL and segs[2]["progress_t"] < 60.0
    assert [(s["start"], s["end"]) for s in segs] == [(0.0, 20.0), (20.0, 40.0), (40.0, 60.0)]

    calls = []
    real = FrameStream

    def spy(*a, **k):
        calls.append((k.get("start"), k.get("end")))
        return real(*a, **k)
    monkeypatch.setattr(az, "FrameStream", spy)
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: pytest.fail("不應重新校準"))
    doc = az.analyze(str(multi_video), profile, cache_dir=cache, jobs=3)
    calls.sort(key=lambda c: (c[1] is None, c[1]))
    assert len(calls) == 2  # 只重跑 seg1、seg2，seg0 已完成

    def frm(start, p):
        own = max(start, p - az.RESUME_BACK)
        return max(0.0, own - az.SEGMENT_PREROLL)
    assert calls[0] == (pytest.approx(frm(20.0, segs[1]["progress_t"])), 40.0 + az.SEGMENT_POSTROLL)
    assert calls[1] == (pytest.approx(frm(40.0, segs[2]["progress_t"])), None)
    assert doc["analysis"]["status"] == "done"
    x, y = _knocks(full), _knocks(doc)
    assert len(x) == len(y) == 5
    for (ta, xa), (tb, xb) in zip(x, y):
        assert ta == tb and xa == pytest.approx(xb, abs=0.3)


def test_ipc_jobs_validation():
    from aditor import ipc
    assert ipc._jobs(None) is None and ipc._jobs(3) == 3
    for bad in (0, -1, "2", True, 1.5):
        with pytest.raises(ipc.BadRequest):
            ipc._jobs(bad)
