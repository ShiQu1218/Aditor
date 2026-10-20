import pytest

from aditor.probe import ProbeError, is_16x9, keyframes, probe
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
    v = make_video(tmp_path, "k.mp4", 6.0, start_time=5.0)  # make_video uses -g 60.
    kf = keyframes(str(v))
    assert kf[0] == pytest.approx(0.0, abs=0.05) and kf[1] == pytest.approx(1.0, abs=0.05)


def test_keyframes_use_container_time_base_when_video_starts_late(tmp_path):
    """M3: an MKV whose video starts 0.5 seconds after the audio. Event timestamps use the container start (the ffmpeg decode timeline),
    and keyframes must use the same base (the first keyframe is at 0.5, not 0)."""
    import subprocess
    from aditor import ffbin
    out = tmp_path / "late.mkv"
    r = subprocess.run([ffbin.ffmpeg(), "-v", "error", "-y",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
                        "-itsoffset", "0.5", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3",
                        "-map", "1:v", "-map", "0:a", "-c:v", "libx264", "-g", "30", "-c:a", "aac", str(out)],
                       capture_output=True)
    assert r.returncode == 0, r.stderr.decode(errors="replace")
    kf = keyframes(str(out))
    assert kf[0] == pytest.approx(0.5, abs=0.05) and kf[1] == pytest.approx(1.5, abs=0.05)
