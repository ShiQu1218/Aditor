"""Icon scale calibration: calibrate each video once, then compare at a single scale."""
import cv2
import numpy as np
import pytest

from aditor import calibrate
from conftest import FIXTURES, make_video


def test_pick_scale_median_and_snap():
    assert calibrate.pick_scale([]) == 1.0
    assert calibrate.pick_scale([1.0, 1.0, 0.95]) == 1.0
    assert calibrate.pick_scale([1.05, 1.1, 1.1, 1.05, 1.1]) == 1.1
    assert calibrate.pick_scale([0.95, 1.0]) == 1.0   # Between two scales, choose the one closer to 1.0.


@pytest.mark.parametrize("scale", [1.0, 0.9, 1.1])
def test_calibrate_finds_icon_scale_on_synthetic_video(tmp_path, profile, scale):
    """Scale a real knock banner and overlay it on a video (simulating HUD scaling); calibration should recover that scale."""
    from aditor.probe import probe
    img = cv2.imdecode(np.fromfile(str(FIXTURES / "en" / "pos" / "knock_a002500.png"), np.uint8),
                       cv2.IMREAD_COLOR)[:180]
    h, w = img.shape[:2]
    # Scale around the banner center and place it back on an 800x180 canvas.
    r = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)
    canvas = np.zeros_like(img)
    ys, xs = (h - r.shape[0]) // 2, (w - r.shape[1]) // 2
    y0, x0 = max(ys, 0), max(xs, 0)
    cy0, cx0 = max(-ys, 0), max(-xs, 0)
    hh, ww = min(h - y0, r.shape[0] - cy0), min(w - x0, r.shape[1] - cx0)
    canvas[y0:y0 + hh, x0:x0 + ww] = r[cy0:cy0 + hh, cx0:cx0 + ww]
    png = tmp_path / "b.png"
    cv2.imencode(".png", canvas)[1].tofile(str(png))
    v = make_video(tmp_path, "s.mp4", 12, overlay=(png, [(1.0, 11.0)]))
    got = calibrate.calibrate(str(v), probe(str(v)), profile, max_scan_seconds=20)
    assert got == pytest.approx(scale, abs=0.051)


def test_calibrate_no_hits_returns_one(tmp_path, profile):
    from conftest import make_video
    from aditor.models import VideoInfo
    p = make_video(tmp_path, "v.mp4", 4)
    info = VideoInfo(str(p), 4.0, 1920, 1080, "h264", 0.0, p.stat().st_size, 0.0)
    assert calibrate.calibrate(str(p), info, profile, max_scan_seconds=10) == 1.0


def test_calibrate_cancel_raises_and_closes_stream(tmp_path, profile, monkeypatch):
    import threading
    from conftest import make_video
    from aditor.errors import Cancelled
    from aditor.models import VideoInfo
    p = make_video(tmp_path, "v.mp4", 6)
    info = VideoInfo(str(p), 6.0, 1920, 1080, "h264", 0.0, p.stat().st_size, 0.0)
    closed = []
    real = calibrate.FrameStream

    class Spy(real):
        def close(self):
            closed.append(True)
            super().close()
    monkeypatch.setattr(calibrate, "FrameStream", Spy)
    ev = threading.Event()
    ev.set()
    with pytest.raises(Cancelled):
        calibrate.calibrate(str(p), info, profile, cancel=ev)
    assert closed


def test_calibration_honours_no_hwaccel(tmp_path, profile, monkeypatch):
    """M2: calibration must not use the GPU when --no-hwaccel is set."""
    from aditor import calibrate as cal
    from aditor.models import VideoInfo
    seen = []

    class Fake:
        def __init__(self, *a, **k):
            seen.append(k.get("hwaccel", True))

        def __iter__(self):
            return iter(())

        def close(self):
            pass
    monkeypatch.setattr(cal, "FrameStream", Fake)
    info = VideoInfo("x.mp4", 100.0, 1920, 1080, "h264", 0.0, 1, 0.0)
    cal.calibrate("x.mp4", info, profile, hwaccel=False)
    assert seen and not any(seen)


def test_learn_keywords_failing_segment_stops_the_others_and_reports_the_real_error(profile, monkeypatch):
    """When keyword-learning segments run in parallel and one decode fails, stop the others immediately (without scanning all 900 seconds) and report the actual error."""
    import time
    from aditor import calibrate as cal
    from aditor.decode import DecodeError
    from aditor.errors import Cancelled
    from aditor.models import VideoInfo

    stopped = []

    def fake_scan(path, prof, scale, start, end, cancel, codec, hwaccel, abort=None):
        if start == 0.0:
            raise DecodeError("boom")
        assert abort is not None and abort.wait(timeout=10), "Other segments did not receive the stop signal"
        stopped.append(start)
        raise Cancelled()

    monkeypatch.setattr(cal, "_scan_segment", fake_scan)
    info = VideoInfo("x.mp4", 600.0, 1920, 1080, "h264", 0.0, 1, 0.0)
    t0 = time.monotonic()
    with pytest.raises(DecodeError):
        cal.learn_keywords("x.mp4", info, profile, 1.0, jobs=4)
    assert time.monotonic() - t0 < 5
    assert len(stopped) == 3
