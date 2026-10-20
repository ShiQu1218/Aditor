import pytest

from aditor.probe import ProbeError, _frame_rate, is_16x9, keyframes, probe
from conftest import make_video


def test_is_16x9():
    assert is_16x9(1920, 1080) and is_16x9(1916, 1080)
    assert not is_16x9(1728, 1080) and not is_16x9(1440, 1080)


def test_probe_start_time(tmp_path):
    v = make_video(tmp_path, "空白 名稱.mp4", 4.0, start_time=5.0)
    info = probe(str(v))
    assert info.width == 1920 and info.height == 1080
    assert abs(info.start_time - 5.0) < 0.1 and abs(info.duration - 4.0) < 0.2


def test_probe_frame_rate_and_pixel_format(tmp_path):
    v = make_video(tmp_path, "fps.mp4", 2.0)  # make_video renders 60 fps.
    info = probe(str(v))
    assert info.fps == pytest.approx(60.0, abs=0.01)
    assert info.pix_fmt == "yuv420p"
    assert info.to_dict()["fps"] == pytest.approx(60.0, abs=0.01)


@pytest.mark.parametrize("aspect", [None, "1920x1440"])
def test_probe_game_aspect_metadata(tmp_path, aspect):
    v = make_video(tmp_path, "aspect.mp4", 0.5, game_aspect=aspect)
    info = probe(str(v))
    assert info.game_aspect == aspect
    assert info.to_dict()["game_aspect"] == aspect


def test_probe_game_aspect_tag_is_case_insensitive(tmp_path, monkeypatch):
    from aditor import probe as module
    v = tmp_path / "aspect.mp4"
    v.touch()
    monkeypatch.setattr(module, "_run", lambda args: {
        "streams": [{"width": 1920, "height": 1080}],
        "format": {"duration": "1", "tags": {"ADITOR_GAME_ASPECT": "1920x1440"}},
    })
    assert probe(str(v)).game_aspect == "1920x1440"


@pytest.mark.parametrize("avg,real,expected", [
    ("144/1", "144/1", 144.0),
    ("30000/1001", "60/1", 30000 / 1001),
    ("0/0", "120/1", 120.0),
    ("0/0", "0/0", 0.0),
    (None, "bad", 0.0),
])
def test_parse_frame_rate_prefers_average_then_real(avg, real, expected):
    assert _frame_rate({"avg_frame_rate": avg, "r_frame_rate": real}) == pytest.approx(expected)


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
