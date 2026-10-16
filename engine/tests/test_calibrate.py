"""水平比例校準。"""
import cv2
import pytest

from apexhl import calibrate


def test_scan_scales_identity(zh_detector, pos_banners):
    assert calibrate.scan_scales(pos_banners[:5], zh_detector) == pytest.approx(1.0)


def test_scan_scales_stretched(zh_detector, pos_banners):
    # 把正例 banner 水平拉伸 1.10 倍（模擬拉伸解析度），應找回 1/1.10 ≈ 0.90
    stretched = [cv2.resize(b, None, fx=1.10, fy=1.0) for b in pos_banners[:5]]
    assert calibrate.scan_scales(stretched, zh_detector) == pytest.approx(0.90, abs=0.05)


def test_scan_scales_empty(zh_detector):
    assert calibrate.scan_scales([], zh_detector) == 1.0


def test_calibrate_no_hits_returns_one(tmp_path, zh_profile):
    from conftest import make_video
    from apexhl.models import VideoInfo
    p = make_video(tmp_path, "v.mp4", 4)
    info = VideoInfo(str(p), 4.0, 1920, 1080, "h264", 0.0, p.stat().st_size, 0.0)
    assert calibrate.calibrate(str(p), info, zh_profile, max_scan_seconds=10) == 1.0


def test_calibrate_cancel_raises_and_closes_stream(tmp_path, zh_profile, monkeypatch):
    import threading
    from conftest import make_video
    from apexhl.errors import Cancelled
    from apexhl.models import VideoInfo
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
        calibrate.calibrate(str(p), info, zh_profile, cancel=ev)
    assert closed


def test_calibration_honours_no_hwaccel(tmp_path, zh_profile, monkeypatch):
    """M2：--no-hwaccel 時校準也不得走 GPU。"""
    from apexhl import calibrate as cal
    from apexhl.models import VideoInfo
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
    cal.calibrate("x.mp4", info, zh_profile, hwaccel=False)
    cal.calibrate_auto("x.mp4", info, [zh_profile], hwaccel=False)
    assert seen and not any(seen)
