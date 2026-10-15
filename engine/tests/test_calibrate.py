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
