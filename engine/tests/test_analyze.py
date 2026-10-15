import threading

import pytest

from apexhl import analyze as az
from apexhl.cache import cache_path, load_cache, save_cache
from apexhl.decode import FrameStream
from conftest import make_video

SPANS = [(2.0, 4.5), (10.0, 12.5)]


@pytest.fixture
def fixture_video(tmp_path, knock_banner_png):
    return make_video(tmp_path, "含 空白.mp4", 15, overlay=(knock_banner_png, SPANS))


def test_analyze_synthetic_no_events(tmp_path, zh_profile):
    v = make_video(tmp_path, "plain.mp4", 6)
    doc = az.analyze(str(v), zh_profile, cache_dir=tmp_path / "cache")
    assert doc["events"] == []
    assert doc["analysis"]["status"] == "done"
    assert doc["keyframes"] and doc["clips"] == []
    assert doc["cache_path"] == str(cache_path(str(v), tmp_path / "cache"))
    assert load_cache(cache_path(str(v), tmp_path / "cache"))["analysis"]["status"] == "done"


def test_analyze_uses_cache(tmp_path, zh_profile, monkeypatch):
    v = make_video(tmp_path, "plain.mp4", 4)
    az.analyze(str(v), zh_profile, cache_dir=tmp_path / "cache")

    def boom(*a, **k):
        raise AssertionError("不應解碼")
    monkeypatch.setattr(az, "FrameStream", boom)
    monkeypatch.setattr(az, "calibrate", boom)
    doc = az.analyze(str(v), zh_profile, cache_dir=tmp_path / "cache")
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


def test_cancel_writes_partial(tmp_path, zh_profile, monkeypatch):
    v = make_video(tmp_path, "plain.mp4", 8)
    cancel = threading.Event()
    monkeypatch.setattr(az, "FrameStream", _CancelAt(3.0, cancel))
    with pytest.raises(az.Cancelled):
        az.analyze(str(v), zh_profile, cache_dir=tmp_path / "cache", cancel=cancel)
    doc = load_cache(cache_path(str(v), tmp_path / "cache"))
    assert doc["analysis"]["status"] == "partial"
    assert 2.0 <= doc["analysis"]["progress_t"] < 3.0


def test_resume_no_duplicates(tmp_path, zh_profile, fixture_video, monkeypatch):
    cache = tmp_path / "cache"
    full = az.analyze(str(fixture_video), zh_profile, cache_dir=cache / "full")
    knocks = [e for e in full["events"] if e["type"] == "knock"]
    assert len(knocks) == 2, full["events"]

    cancel = threading.Event()
    with monkeypatch.context() as m:
        m.setattr(az, "FrameStream", _CancelAt(11.0, cancel))
        with pytest.raises(az.Cancelled):
            az.analyze(str(fixture_video), zh_profile, cache_dir=cache, cancel=cancel)
    part = load_cache(cache_path(str(fixture_video), cache))
    assert part["analysis"]["status"] == "partial"
    assert len(part["events"]) == 2  # 第二個提示在取消前已成立

    starts = []
    real = FrameStream

    def spy(*a, **k):
        starts.append(k.get("start"))
        return real(*a, **k)
    monkeypatch.setattr(az, "FrameStream", spy)
    doc = az.analyze(str(fixture_video), zh_profile, cache_dir=cache)
    assert starts == [pytest.approx(part["analysis"]["progress_t"] - 5.0)]
    ks = [e for e in doc["events"] if e["type"] == "knock"]
    assert len(ks) == 2
    assert ks[0]["t"] == pytest.approx(2.0, abs=0.3)
    assert ks[1]["t"] == pytest.approx(10.0, abs=0.3)
    assert doc["analysis"]["status"] == "done"
    assert [e["t"] for e in ks] == [e["t"] for e in knocks]


def test_reanalysis_keeps_user_state(tmp_path, zh_profile, fixture_video):
    cache = tmp_path / "cache"
    doc = az.analyze(str(fixture_video), zh_profile, cache_dir=cache)
    doc["events"][0]["deleted"] = True
    save_cache(cache_path(str(fixture_video), cache), doc)
    doc2 = az.analyze(str(fixture_video), zh_profile, cache_dir=cache, force=True)
    assert doc2["events"][0]["deleted"] is True
    assert doc2["unmatched"] == []


def test_progress_throttled_and_final(tmp_path, zh_profile):
    v = make_video(tmp_path, "plain.mp4", 6)
    calls = []
    az.analyze(str(v), zh_profile, cache_dir=tmp_path / "cache", on_progress=lambda t, d: calls.append((t, d)))
    assert calls[-1][0] == pytest.approx(calls[-1][1])
    assert len(calls) < 6 * 4 + 2  # 少於逐格呼叫


def test_cancel_during_calibration_leaves_partial(tmp_path, zh_profile):
    from apexhl.errors import Cancelled
    assert az.Cancelled is Cancelled
    v = make_video(tmp_path, "plain.mp4", 6)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(az.Cancelled):
        az.analyze(str(v), zh_profile, cache_dir=tmp_path / "cache", cancel=cancel)
    doc = load_cache(cache_path(str(v), tmp_path / "cache"))
    assert doc["analysis"]["status"] == "partial" and doc["analysis"]["progress_t"] == 0.0
