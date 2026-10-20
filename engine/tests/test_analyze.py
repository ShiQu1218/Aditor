import threading

import pytest

from aditor import analyze as az
from aditor.cache import cache_path, load_cache, save_cache
from aditor.decode import FrameStream
from conftest import make_video

SPANS = [(2.0, 4.5), (10.0, 12.5)]


@pytest.fixture
def short_learn(monkeypatch):
    """Learn keywords only from the first second, while decoding, and save segment progress after learning. This lets a short synthetic video test saving and resuming after cancellation.
    The synthetic video has no learnable anchors, so disable extended learning (progress is not saved during extended learning; see test_late_learning)."""
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
        raise AssertionError("Decoding should not occur")
    monkeypatch.setattr(az, "FrameStream", boom)
    monkeypatch.setattr(az, "calibrate", boom)
    doc = az.analyze(str(v), profile, cache_dir=tmp_path / "cache")
    assert doc["analysis"]["status"] == "done"


class _CancelAt:
    """Wrap FrameStream and set cancel before yielding a frame with t >= at."""

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
    assert len(part["events"]) == 2  # The second banner was already confirmed before cancellation.

    starts = []
    real = FrameStream

    def spy(*a, **k):
        starts.append(k.get("start"))
        return real(*a, **k)
    monkeypatch.setattr(az, "FrameStream", spy)
    doc = az.analyze(str(fixture_video), profile, cache_dir=cache)
    # Resume ownership from RESUME_BACK, then add PREROLL context (this video is short, so start at 0).
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
    assert len(calls) < 6 * 4 + 2  # Fewer calls than decoding every frame.


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
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: pytest.fail("Must not recalibrate"))
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
    part["analysis"]["keywords"] = {"assist": {"shape": [27, 64], "q8": "AAAA"}}  # Corrupt data.
    save_cache(cp, part)
    learned = []
    real = az._Learner
    monkeypatch.setattr(az, "_Learner", lambda *a, **k: learned.append(1) or real(*a, **k))
    doc = az.analyze(str(v), profile, cache_dir=cache)
    assert learned == [1] and doc["analysis"]["status"] == "done"
    assert doc["analysis"]["keywords"] == {"assist": None, "knock": None, "assist_by_knock": False}


def test_cancel_before_keywords_learned_keeps_only_calibration(tmp_path, profile, fixture_video, monkeypatch):
    """The learning range (900 seconds by default) covers this short video: cancellation before learning finishes stores only the calibrated scale in partial; resume does not recalibrate, learns while decoding from the start, and matches uninterrupted results."""
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
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: pytest.fail("Must not recalibrate"))
    doc = az.analyze(str(fixture_video), profile, cache_dir=cache)
    assert doc["analysis"]["status"] == "done"
    assert [(e["type"], e["t"]) for e in doc["events"]] == [(e["type"], e["t"]) for e in full["events"]]


@pytest.mark.parametrize("jobs", [1, 3])
def test_in_pass_keywords_equal_separate_learning_pass(tmp_path, profile, multi_video, monkeypatch, jobs):
    """Keywords learned while decoding match the results of an independent scan (calibrate.learn_keywords), regardless of jobs."""
    from aditor.calibrate import learn_keywords
    from aditor.probe import probe
    monkeypatch.setattr(az, "LEARN_SCAN_SECONDS", 45.0)  # Learning range crosses the jobs=3 boundaries at 20 and 40.
    doc = az.analyze(str(multi_video), profile, cache_dir=tmp_path / "c", jobs=jobs)
    sep = learn_keywords(str(multi_video), probe(str(multi_video)), profile, doc["analysis"]["h_scale"],
                         max_scan_seconds=45.0)
    assert sep.knock is not None  # The synthetic knock banners must produce a knock template for this comparison to be meaningful.
    assert doc["analysis"]["keywords"] == sep.to_dict()


# ---- Parallel segment decoding (jobs) ----

def test_plan_segments_overlap_and_last_segment():
    segs = az.plan_segments(60.0, 3, min_len=5.0)
    assert segs == [(0.0, 20.0), (20.0, 40.0), (40.0, 60.0)]
    sg = [az._Seg(a, b, i == 2, 60.0) for i, (a, b) in enumerate(segs)]
    assert [x.dec_end for x in sg] == [20.0 + az.SEGMENT_POSTROLL, 40.0 + az.SEGMENT_POSTROLL, None]  # Decode through the segment post-roll; the last segment reaches the end of the video.


def test_plan_segments_boundaries_on_quarter_grid():
    segs = az.plan_segments(100.0, 3)
    assert all((a / 0.25) == pytest.approx(round(a / 0.25)) for a, _ in segs)
    assert segs[0][0] == 0.0 and segs[-1][1] == 100.0
    assert all(a[1] == b[0] for a, b in zip(segs, segs[1:]))


def test_plan_segments_short_duration_reduces_jobs_to_min_len():
    assert len(az.plan_segments(100.0, 4)) == 3      # Each segment is >= 30 seconds.
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
    # jobs=3 → boundaries at 20 and 40; banners (19,22) and (39,42) cross boundaries, while (24,26) falls in the overlap.
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
    """Wrap FrameStream and record every stream; trigger cancellation in seg2 after seg0 completes, while seg1 waits for cancellation.
    Identify segments by end (seg0 = 20 + post-roll, seg1 = 40 + post-roll, seg2 = None); nominal starts are 0/20/40."""

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
    assert all(i._proc is not None and i._proc.poll() is not None for i in harness.inners)  # No ffmpeg process remains.
    part = load_cache(cache_path(str(multi_video), cache))
    a = part["analysis"]
    assert a["status"] == "partial" and len(a["segments"]) == 3
    segs = a["segments"]
    assert segs[0]["progress_t"] == pytest.approx(20.0 + az.SEGMENT_POSTROLL)  # seg0 is complete, including post-roll.
    assert segs[1]["progress_t"] < 40.0 + az.SEGMENT_POSTROLL and segs[2]["progress_t"] < 60.0
    assert [(s["start"], s["end"]) for s in segs] == [(0.0, 20.0), (20.0, 40.0), (40.0, 60.0)]

    calls = []
    real = FrameStream

    def spy(*a, **k):
        calls.append((k.get("start"), k.get("end")))
        return real(*a, **k)
    monkeypatch.setattr(az, "FrameStream", spy)
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: pytest.fail("Calibration should not run again."))
    doc = az.analyze(str(multi_video), profile, cache_dir=cache, jobs=3)
    calls.sort(key=lambda c: (c[1] is None, c[1]))
    assert len(calls) == 2  # Only seg1 and seg2 run again; seg0 is already complete.

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


def test_analyze_stretched_4_3_video_with_game_aspect(tmp_path, profile, knock_banner_png):
    from aditor.layout import parse_aspect
    v = make_video(tmp_path, "4比3.mp4", 15, overlay=(knock_banner_png, SPANS), game_height=1440)
    four = profile.with_layout(parse_aspect("4:3"))
    plain = az.analyze(str(v), profile, cache_dir=tmp_path / "cache")
    assert [e for e in plain["events"] if e["type"] == "knock"] == []
    doc = az.analyze(str(v), four, cache_dir=tmp_path / "cache")  # A different game aspect invalidates the cache.
    assert len([e for e in doc["events"] if e["type"] == "knock"]) == 2, doc["events"]
    assert doc["analysis"]["aspect_squash"] == 0.75


@pytest.mark.parametrize("tag,explicit,expected", [
    ("1920x1440", None, 0.75),
    ("1920x1440", "16:9", 1.0),
    ("1920x1440", "5:4", 0.703125),
    ("invalid", None, 1.0),
    ("21:9", None, 1.0),
    (None, None, 1.0),
])
def test_analyze_resolves_recorded_aspect(tmp_path, profile, tag, explicit, expected):
    from aditor.layout import parse_aspect
    v = make_video(tmp_path, "tagged.mp4", 0.5, game_aspect=tag)
    kwargs = {"layout": parse_aspect(explicit)} if explicit else {}
    doc = az.analyze(str(v), profile, cache_dir=tmp_path / "cache", **kwargs)
    assert doc["analysis"]["aspect_squash"] == expected


def test_analyze_tagged_video_cache_and_explicit_override(tmp_path, profile, monkeypatch):
    from aditor.layout import Layout
    v = make_video(tmp_path, "tagged.mp4", 0.5, game_aspect="1920x1440")
    cache = tmp_path / "cache"
    doc = az.analyze(str(v), profile, cache_dir=cache)
    assert doc["analysis"]["aspect_squash"] == 0.75
    with monkeypatch.context() as m:
        m.setattr(az, "calibrate", lambda *a, **kw: pytest.fail("Matching cache should be reused"))
        assert az.analyze(str(v), profile, cache_dir=cache)["analysis"]["aspect_squash"] == 0.75
    assert az.analyze(str(v), profile, cache_dir=cache, layout=Layout(1.0))["analysis"]["aspect_squash"] == 1.0


def _forbid(monkeypatch, name="detect_aspect"):
    monkeypatch.setattr(az, name, lambda *a, **k: pytest.fail("Aspect detection should not run"))


def _detects(monkeypatch, squash):
    """Make the detector report a 4:3-like layout, as real detection cannot work on synthetic footage."""
    from aditor.aspect import Detection
    from aditor.layout import Layout
    calls = []

    def detect(*a, **k):
        calls.append(a)
        return Detection(Layout(squash), True)
    monkeypatch.setattr(az, "detect_aspect", detect)
    return calls


def test_analyze_detects_the_aspect_of_an_untagged_video(tmp_path, profile, knock_banner_png, monkeypatch):
    v = make_video(tmp_path, "4比3.mp4", 15, overlay=(knock_banner_png, SPANS), game_height=1440)
    calls = _detects(monkeypatch, 0.75)
    cache = tmp_path / "cache"
    doc = az.analyze(str(v), profile, cache_dir=cache)
    assert len(calls) == 1
    assert len([e for e in doc["events"] if e["type"] == "knock"]) == 2, doc["events"]
    assert doc["analysis"]["aspect_squash"] == 0.75 and doc["analysis"]["aspect_source"] == "detected"

    def boom(*a, **k):
        raise AssertionError("Decoding should not occur")
    for name in ("FrameStream", "calibrate", "detect_aspect"):
        monkeypatch.setattr(az, name, boom)
    again = az.analyze(str(v), profile, cache_dir=cache)  # The cache records the detected squash and is accepted as is.
    assert again["analysis"]["aspect_squash"] == 0.75 and again["analysis"]["aspect_source"] == "detected"


def test_analyze_untagged_video_without_hud_uses_the_default(tmp_path, profile):
    v = make_video(tmp_path, "plain.mp4", 4)
    doc = az.analyze(str(v), profile, cache_dir=tmp_path / "cache")
    assert doc["analysis"]["aspect_squash"] == 1.0 and doc["analysis"]["aspect_source"] == "default"


def test_analyze_aspect_sources(tmp_path, profile, monkeypatch):
    from aditor.layout import Layout
    tagged = make_video(tmp_path, "tagged.mp4", 0.5, game_aspect="1920x1440")
    plain = make_video(tmp_path, "plain.mp4", 0.5)
    _forbid(monkeypatch)
    doc = az.analyze(str(tagged), profile, cache_dir=tmp_path / "c1")
    assert (doc["analysis"]["aspect_squash"], doc["analysis"]["aspect_source"]) == (0.75, "tag")
    doc = az.analyze(str(tagged), profile, cache_dir=tmp_path / "c2", layout=Layout(1.0))  # Explicit beats the tag.
    assert (doc["analysis"]["aspect_squash"], doc["analysis"]["aspect_source"]) == (1.0, "explicit")
    doc = az.analyze(str(plain), profile, cache_dir=tmp_path / "c3", layout=Layout(0.75))  # Explicit beats detection.
    assert (doc["analysis"]["aspect_squash"], doc["analysis"]["aspect_source"]) == (0.75, "explicit")
    doc = az.analyze(str(plain), profile.with_layout(Layout(0.9)), cache_dir=tmp_path / "c4")  # Profile layouts are explicit.
    assert (doc["analysis"]["aspect_squash"], doc["analysis"]["aspect_source"]) == (0.9, "explicit")


def test_analyze_tag_beats_detection_and_keeps_the_strict_cache_check(tmp_path, profile, monkeypatch):
    from aditor.layout import Layout
    v = make_video(tmp_path, "tagged.mp4", 0.5, game_aspect="1920x1440")
    cache = tmp_path / "cache"
    _forbid(monkeypatch)
    az.analyze(str(v), profile, cache_dir=cache)
    with monkeypatch.context() as m:
        m.setattr(az, "calibrate", lambda *a, **kw: pytest.fail("Matching cache should be reused"))
        az.analyze(str(v), profile, cache_dir=cache)
    doc = az.analyze(str(v), profile, cache_dir=cache, layout=Layout(1.0))  # A different explicit aspect reanalyzes.
    assert doc["analysis"]["aspect_squash"] == 1.0


def test_analyze_invalid_tag_is_detected(tmp_path, profile, monkeypatch):
    v = make_video(tmp_path, "bad.mp4", 0.5, game_aspect="21:9")
    calls = _detects(monkeypatch, 0.9)
    doc = az.analyze(str(v), profile, cache_dir=tmp_path / "cache")
    assert len(calls) == 1 and doc["analysis"]["aspect_source"] == "detected" and doc["analysis"]["aspect_squash"] == 0.9


def test_analyze_untagged_cache_is_accepted_whatever_the_squash(tmp_path, profile, monkeypatch):
    v = make_video(tmp_path, "plain.mp4", 4)
    cache = tmp_path / "cache"
    _detects(monkeypatch, 0.703125)
    doc = az.analyze(str(v), profile, cache_dir=cache)
    assert doc["analysis"]["aspect_squash"] == 0.703125
    cp = cache_path(str(v), cache)
    stored = load_cache(cp)
    stored["analysis"].pop("aspect_source")  # A cache written before the source was recorded.
    save_cache(cp, stored)
    for name in ("FrameStream", "calibrate", "detect_aspect"):
        monkeypatch.setattr(az, name, lambda *a, **k: pytest.fail("Decoding should not occur"))
    assert az.analyze(str(v), profile, cache_dir=cache)["analysis"]["aspect_squash"] == 0.703125


def test_analyze_resume_reuses_the_stored_squash(tmp_path, profile, fixture_video, monkeypatch, short_learn):
    cache = tmp_path / "cache"
    cancel = threading.Event()
    calls = _detects(monkeypatch, 0.75)
    with monkeypatch.context() as m:
        m.setattr(az, "FrameStream", _CancelAt(11.0, cancel))
        with pytest.raises(az.Cancelled):
            az.analyze(str(fixture_video), profile, cache_dir=cache, cancel=cancel)
    part = load_cache(cache_path(str(fixture_video), cache))["analysis"]
    assert part["status"] == "partial" and part["aspect_squash"] == 0.75 and part["aspect_source"] == "detected"
    assert len(calls) == 1
    _forbid(monkeypatch)
    monkeypatch.setattr(az, "calibrate", lambda *a, **k: pytest.fail("Calibration should not run again."))
    doc = az.analyze(str(fixture_video), profile, cache_dir=cache)
    assert doc["analysis"]["status"] == "done"
    assert doc["analysis"]["aspect_squash"] == 0.75 and doc["analysis"]["aspect_source"] == "detected"


def test_analyze_cancelled_detection_leaves_a_partial_that_is_not_resumed(tmp_path, profile, monkeypatch):
    v = make_video(tmp_path, "plain.mp4", 4)
    cache = tmp_path / "cache"

    def cancelled(*a, **k):
        raise az.Cancelled()
    monkeypatch.setattr(az, "detect_aspect", cancelled)
    with pytest.raises(az.Cancelled):
        az.analyze(str(v), profile, cache_dir=cache)
    assert load_cache(cache_path(str(v), cache))["analysis"]["status"] == "partial"
    calls = _detects(monkeypatch, 0.75)
    assert az.analyze(str(v), profile, cache_dir=cache)["analysis"]["aspect_squash"] == 0.75
    assert len(calls) == 1
