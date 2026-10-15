import pytest

from apexhl import decode
from apexhl.decode import FrameStream
from conftest import make_video


def test_frame_times_and_shapes(tmp_path, zh_profile):
    v = make_video(tmp_path, "中文 路徑.mp4", 3.0)
    frames = list(FrameStream(str(v), zh_profile))
    assert len(frames) == 12
    assert [f[0] for f in frames[:3]] == [0.0, 0.25, 0.5]
    x, y, w, h = zh_profile.banner_roi
    assert frames[0][1].shape == (h, w, 3)
    assert frames[0][2].shape == (zh_profile.spec_roi[3], zh_profile.spec_roi[2], 3)


@pytest.mark.parametrize("start_time,vfr", [(5.0, False), (0.0, True)])
def test_mark_time_alignment(tmp_path, zh_profile, start_time, vfr):
    v = make_video(tmp_path, "m.mp4", 6.0, start_time=start_time, vfr=vfr, marks=[(3.0, 3.6)])
    lit = [t for t, b, s in FrameStream(str(v), zh_profile) if b.mean() > 200]
    assert lit[0] == pytest.approx(3.0, abs=0.25)


def test_resume_start(tmp_path, zh_profile):
    v = make_video(tmp_path, "r.mp4", 6.0, marks=[(4.0, 4.6)])
    lit = [t for t, b, s in FrameStream(str(v), zh_profile, start=2.0) if b.mean() > 200]
    assert lit[0] == pytest.approx(4.0, abs=0.25)


def test_hwaccel_fallback(tmp_path, zh_profile, monkeypatch):
    monkeypatch.setattr(decode, "HWACCEL_ARGS", ["-hwaccel", "nonexistent_accel"])
    v = make_video(tmp_path, "h.mp4", 1.0)
    fs = FrameStream(str(v), zh_profile)
    assert len(list(fs)) == 4 and fs.used_hwaccel is False


@pytest.mark.timeout(60)
def test_stderr_flood_no_deadlock(tmp_path, zh_profile, monkeypatch):
    monkeypatch.setattr(decode, "LOGLEVEL", "debug")  # 大量 stderr
    v = make_video(tmp_path, "d.mp4", 10.0)
    fs = FrameStream(str(v), zh_profile)
    assert len(list(fs)) == 40
    assert len(fs.stderr_tail.encode()) <= 64 * 1024


def test_decode_error_on_bad_file(tmp_path, zh_profile):
    p = tmp_path / "bad.mp4"
    p.write_bytes(b"garbage")
    with pytest.raises(decode.DecodeError):
        list(FrameStream(str(p), zh_profile))


def test_close_terminates_ffmpeg(tmp_path, zh_profile):
    v = make_video(tmp_path, "c.mp4", 10.0)
    fs = FrameStream(str(v), zh_profile)
    it = iter(fs)
    next(it)
    it.close()
    assert fs._proc.poll() is not None
