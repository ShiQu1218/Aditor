import pytest

from apexhl.probe import ProbeError, is_16x9, keyframes, probe
from conftest import make_video


def test_is_16x9():
    assert is_16x9(1920, 1080) and is_16x9(1916, 1080)
    assert not is_16x9(1728, 1080) and not is_16x9(1440, 1080)


def test_probe_start_time(tmp_path):
    v = make_video(tmp_path, "空白 名稱.mp4", 4.0, start_time=5.0)
    info = probe(str(v))
    assert info.width == 1920 and info.height == 1080
    assert abs(info.start_time - 5.0) < 0.1 and abs(info.duration - 4.0) < 0.2


def test_probe_bad_file(tmp_path):
    p = tmp_path / "x.mp4"
    p.write_bytes(b"not a video")
    with pytest.raises(ProbeError):
        probe(str(p))


def test_keyframes_relative(tmp_path):
    v = make_video(tmp_path, "k.mp4", 6.0, start_time=5.0)  # make_video 用 -g 60
    kf = keyframes(str(v))
    assert kf[0] == pytest.approx(0.0, abs=0.05) and kf[1] == pytest.approx(1.0, abs=0.05)
