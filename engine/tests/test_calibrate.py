"""圖示尺度校準：每支影片校準一次，之後單尺度比對。"""
import cv2
import numpy as np
import pytest

from aditor import calibrate
from conftest import FIXTURES, make_video


def test_pick_scale_median_and_snap():
    assert calibrate.pick_scale([]) == 1.0
    assert calibrate.pick_scale([1.0, 1.0, 0.95]) == 1.0
    assert calibrate.pick_scale([1.05, 1.1, 1.1, 1.05, 1.1]) == 1.1
    assert calibrate.pick_scale([0.95, 1.0]) == 1.0   # 落在兩尺度之間 → 取較接近 1.0 者


@pytest.mark.parametrize("scale", [1.0, 0.9, 1.1])
def test_calibrate_finds_icon_scale_on_synthetic_video(tmp_path, profile, scale):
    """把真實擊倒橫幅縮放後疊到影片上（模擬 HUD 縮放），校準應找回該尺度。"""
    from aditor.probe import probe
    img = cv2.imdecode(np.fromfile(str(FIXTURES / "en" / "pos" / "knock_a002500.png"), np.uint8),
                       cv2.IMREAD_COLOR)[:180]
    h, w = img.shape[:2]
    # 以橫幅中心縮放，貼回 800x180 畫布
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
    """M2：--no-hwaccel 時校準也不得走 GPU。"""
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
    """關鍵字學習切段平行時，一段解碼失敗 → 其他段立刻停止（不必各自掃完 900 秒），且回報的是真正的錯誤。"""
    import time
    from aditor import calibrate as cal
    from aditor.decode import DecodeError
    from aditor.errors import Cancelled
    from aditor.models import VideoInfo

    stopped = []

    def fake_scan(path, prof, scale, start, end, cancel, codec, hwaccel, abort=None):
        if start == 0.0:
            raise DecodeError("boom")
        assert abort is not None and abort.wait(timeout=10), "其他段沒有收到停止通知"
        stopped.append(start)
        raise Cancelled()

    monkeypatch.setattr(cal, "_scan_segment", fake_scan)
    info = VideoInfo("x.mp4", 600.0, 1920, 1080, "h264", 0.0, 1, 0.0)
    t0 = time.monotonic()
    with pytest.raises(DecodeError):
        cal.learn_keywords("x.mp4", info, profile, 1.0, jobs=4)
    assert time.monotonic() - t0 < 5
    assert len(stopped) == 3
