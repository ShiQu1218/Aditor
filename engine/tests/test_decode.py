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


def test_build_input_args_av1_uses_native_decoder_with_d3d11va():
    # 解碼器選項必須在 -i 之前；-ss 也在 -i 之前，且位於 hwaccel 之後
    assert decode.build_input_args("av1", True, 2.5) == ["-hwaccel", "d3d11va", "-c:v", "av1", "-ss", "2.500"]


def test_build_input_args_other_codec_keeps_hwaccel_auto():
    assert decode.build_input_args("h264", True, 0.0) == ["-hwaccel", "auto"]
    assert decode.build_input_args(None, True, 0.0) == ["-hwaccel", "auto"]


def test_build_input_args_no_hwaccel_only_start():
    assert decode.build_input_args("av1", False, 0.0) == []
    assert decode.build_input_args("h264", False, 3.0) == ["-ss", "3.000"]


def test_build_input_args_av1_hwaccel_before_ss_when_start_positive():
    args = decode.build_input_args("av1", True, 300.0)
    assert args.index("-c:v") < args.index("-ss")


def _av1_clip(tmp_path, seconds=1.0):
    """以 libsvtav1 編一段 AV1 測試影片；沒有 AV1 編碼器時跳過測試。"""
    import subprocess
    from apexhl import ffbin
    ff = ffbin.ffmpeg()
    enc = subprocess.run([ff, "-hide_banner", "-encoders"], capture_output=True).stdout.decode(errors="replace")
    if "libsvtav1" not in enc:
        pytest.skip("ffmpeg 沒有 libsvtav1 編碼器，無法產生 AV1 測試影片")
    out = tmp_path / "av1.mp4"
    subprocess.run([ff, "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"testsrc2=size=640x360:rate=60:duration={seconds}",
                    "-c:v", "libsvtav1", "-preset", "12", "-g", "60", "-pix_fmt", "yuv420p", str(out)],
                   check=True, capture_output=True)
    return out


def test_av1_fallback_drops_c_v_av1(tmp_path, zh_profile, monkeypatch):
    v = _av1_clip(tmp_path)
    monkeypatch.setattr(decode, "AV1_HWACCEL_ARGS", ["-hwaccel", "nonexistent_accel", "-c:v", "av1"])
    cmds = []
    real_popen = decode.subprocess.Popen

    def spy(cmd, *a, **k):
        cmds.append(list(cmd))
        return real_popen(cmd, *a, **k)
    monkeypatch.setattr(decode.subprocess, "Popen", spy)
    fs = FrameStream(str(v), zh_profile, codec="av1")
    assert len(list(fs)) == 4 and fs.used_hwaccel is False
    assert len(cmds) == 2
    assert "nonexistent_accel" in cmds[0] and "-c:v" in cmds[0]
    assert "-hwaccel" not in cmds[1] and "-c:v" not in cmds[1]


def test_av1_decode_with_codec_yields_frames(tmp_path, zh_profile):
    v = _av1_clip(tmp_path)
    frames = list(FrameStream(str(v), zh_profile, codec="av1"))
    assert len(frames) == 4
