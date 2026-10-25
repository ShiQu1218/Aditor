import pytest

from aditor import decode
from aditor.decode import FrameStream
from conftest import make_video


def test_frame_times_and_shapes(tmp_path, profile):
    v = make_video(tmp_path, "中文 路徑.mp4", 3.0)
    frames = list(FrameStream(str(v), profile))
    assert len(frames) == 12
    assert [f[0] for f in frames[:3]] == [0.0, 0.25, 0.5]
    x, y, w, h = profile.banner_roi
    assert frames[0][1].shape == (h, w, 3)
    assert frames[0][2].shape == (profile.spec_roi[3], profile.spec_roi[2], 3)


@pytest.mark.parametrize("start_time,vfr", [(5.0, False), (0.0, True)])
def test_mark_time_alignment(tmp_path, profile, start_time, vfr):
    v = make_video(tmp_path, "m.mp4", 6.0, start_time=start_time, vfr=vfr, marks=[(3.0, 3.6)])
    lit = [t for t, b, s in FrameStream(str(v), profile) if b.mean() > 200]
    assert lit[0] == pytest.approx(3.0, abs=0.25)


def test_resume_start(tmp_path, profile):
    v = make_video(tmp_path, "r.mp4", 6.0, marks=[(4.0, 4.6)])
    lit = [t for t, b, s in FrameStream(str(v), profile, start=2.0) if b.mean() > 200]
    assert lit[0] == pytest.approx(4.0, abs=0.25)


def test_hwaccel_fallback(tmp_path, profile, monkeypatch):
    monkeypatch.setattr(decode, "HWACCEL_ARGS", ["-hwaccel", "nonexistent_accel"])
    v = make_video(tmp_path, "h.mp4", 1.0)
    fs = FrameStream(str(v), profile)
    assert len(list(fs)) == 4 and fs.used_hwaccel is False


@pytest.mark.timeout(60)
def test_stderr_flood_no_deadlock(tmp_path, profile, monkeypatch):
    monkeypatch.setattr(decode, "LOGLEVEL", "debug")  # Lots of stderr output.
    v = make_video(tmp_path, "d.mp4", 10.0)
    fs = FrameStream(str(v), profile)
    assert len(list(fs)) == 40
    assert len(fs.stderr_tail.encode()) <= 64 * 1024


def test_decode_error_on_bad_file(tmp_path, profile):
    p = tmp_path / "bad.mp4"
    p.write_bytes(b"garbage")
    with pytest.raises(decode.DecodeError):
        list(FrameStream(str(p), profile))


def test_close_terminates_ffmpeg(tmp_path, profile):
    v = make_video(tmp_path, "c.mp4", 10.0)
    fs = FrameStream(str(v), profile)
    it = iter(fs)
    next(it)
    it.close()
    assert fs._proc.poll() is not None


GPU = ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"]


def test_build_input_args_av1_uses_native_decoder_with_d3d11va():
    # Decoder options must precede -i; -ss must also precede -i and follow hwaccel.
    assert decode.build_input_args("av1", True, 2.5) == GPU + ["-c:v", "av1", "-ss", "2.500"]


@pytest.mark.parametrize("codec", ["h264", "hevc", "vp9"])
def test_build_input_args_other_gpu_codecs_no_c_v(codec):
    assert decode.build_input_args(codec, True, 0.0) == GPU


def test_build_input_args_unknown_codec_keeps_hwaccel_auto():
    assert decode.build_input_args(None, True, 0.0) == ["-hwaccel", "auto"]
    assert decode.build_input_args("mpeg4", True, 0.0) == ["-hwaccel", "auto"]


def test_build_input_args_no_hwaccel_only_start():
    assert decode.build_input_args("av1", False, 0.0) == []
    assert decode.build_input_args("h264", False, 3.0) == ["-ss", "3.000"]


def test_is_gpu_path():
    assert decode.is_gpu_path("av1", True) and decode.is_gpu_path("h264", True)
    assert not decode.is_gpu_path(None, True) and not decode.is_gpu_path("av1", False)
    assert not decode.is_gpu_path("mpeg4", True)


def test_build_filter_gpu_downloads_after_fps(profile):
    f = decode.build_filter(profile, True)
    assert f.startswith("[0:v]fps=4,hwdownload,format=nv12,format=yuv420p,scale=1920:1080,split")
    assert "hwdownload,format=p010le,format=yuv420p10le," in decode.build_filter(profile, True, "p010le")
    soft = decode.build_filter(profile)
    assert soft.startswith("[0:v]fps=4,scale=1920:1080,split") and "hwdownload" not in soft
    assert f.split("split", 1)[1] == soft.split("split", 1)[1]


def test_frame_stream_end_limits_output(tmp_path, profile):
    v = make_video(tmp_path, "e.mp4", 6.0)
    frames = list(FrameStream(str(v), profile, start=1.0, end=3.0, hwaccel=False))
    assert [f[0] for f in frames] == [1.0 + 0.25 * k for k in range(8)]


def test_build_input_args_av1_hwaccel_before_ss_when_start_positive():
    args = decode.build_input_args("av1", True, 300.0)
    assert args.index("-c:v") < args.index("-ss")


def _av1_clip(tmp_path):
    """Copy the synthetic AV1 fixture; decoding must not depend on an AV1 encoder."""
    import shutil
    from pathlib import Path
    out = tmp_path / "av1.mp4"
    shutil.copyfile(Path(__file__).parent / "fixtures" / "media" / "av1-1s-640x360-60.mp4", out)
    return out


def test_av1_fallback_drops_c_v_av1(tmp_path, profile, monkeypatch):
    v = _av1_clip(tmp_path)
    monkeypatch.setattr(decode, "AV1_HWACCEL_ARGS", ["-hwaccel", "nonexistent_accel", "-c:v", "av1"])
    cmds = []
    real_popen = decode.subprocess.Popen

    def spy(cmd, *a, **k):
        cmds.append(list(cmd))
        return real_popen(cmd, *a, **k)
    monkeypatch.setattr(decode.subprocess, "Popen", spy)
    fs = FrameStream(str(v), profile, codec="av1")
    assert len(list(fs)) == 4 and fs.used_hwaccel is False
    # Hardware nv12 → hardware p010le (retry with 10-bit pixel format only if failure occurs before the first frame) → software.
    assert len(cmds) == 3
    fc = lambda c: c[c.index("-filter_complex") + 1]  # noqa: E731
    assert "nonexistent_accel" in cmds[0] and "-c:v" in cmds[0] and "format=nv12" in fc(cmds[0])
    assert "nonexistent_accel" in cmds[1] and "format=p010le" in fc(cmds[1])
    assert "-hwaccel" not in cmds[2] and "-c:v" not in cmds[2]
    assert "hwdownload" not in fc(cmds[2])


def test_av1_decode_with_codec_yields_frames(tmp_path, profile):
    v = _av1_clip(tmp_path)
    frames = list(FrameStream(str(v), profile, codec="av1"))
    assert len(frames) == 4


def test_av1_hardware_colours_match_software(tmp_path, profile):
    import numpy as np
    v = _av1_clip(tmp_path)
    stream = FrameStream(str(v), profile, codec="av1")
    hardware = list(stream)
    if not stream.used_hwaccel:
        pytest.skip("D3D11VA hardware decoding is unavailable")
    software = list(FrameStream(str(v), profile, codec="av1", hwaccel=False))
    assert len(hardware) == len(software) == 4
    for (th, bh, sh), (ts, bs, ss) in zip(hardware, software):
        assert th == ts
        np.testing.assert_array_equal(bh, bs)
        np.testing.assert_array_equal(sh, ss)


def test_hw_failure_mid_stream_continues_in_software_on_the_same_time_grid(tmp_path, profile, monkeypatch):
    """I7: if hardware decoding fails after producing frames, continue in software from the next frame without omissions or duplicates and with the same timestamp grid."""
    import sys
    import subprocess
    v = make_video(tmp_path, "h.mp4", 3.0)
    bx, by, bw, bh = profile.capture_banner
    sx, sy, sw, sh = profile.capture_spec
    frame_bytes = bw * (bh + sh) * 3
    if profile.capture_killfeed is not None:
        fw, fh = profile.capture_killfeed[2:]
        frame_bytes = max(bw, sw, fw) * (bh + sh + fh + 360) * 3
    real_spawn = FrameStream._spawn
    calls = []
    hw_procs = []

    def spawn(self, hwaccel, start=None):
        calls.append((hwaccel, start))
        if hwaccel:
            code = f"import sys; sys.stdout.buffer.write(bytes({frame_bytes} * 3)); sys.stdout.flush(); sys.exit(1)"
            hw = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, bufsize=0)
            hw_procs.append(hw)
            return hw
        return real_spawn(self, hwaccel, start)
    monkeypatch.setattr(FrameStream, "_spawn", spawn)
    fs = FrameStream(str(v), profile, codec="h264")
    ts = [t for t, _, _ in fs]
    assert fs.used_hwaccel is False
    assert calls[0][0] is True and calls[1] == (False, pytest.approx(0.75))  # Do not retry p010le after a mid-stream failure.
    assert ts == pytest.approx([i * 0.25 for i in range(12)])
    # The failed hardware process's stdout pipe is closed after software replaces it (no handle leak).
    assert hw_procs and hw_procs[0].stdout.closed


def _nvenc_10bit(tmp_path):
    import subprocess
    from aditor import ffbin
    out = tmp_path / "t10.mp4"
    r = subprocess.run([ffbin.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i",
                        "testsrc2=size=1920x1080:rate=60:duration=2", "-pix_fmt", "p010le",
                        "-c:v", "hevc_nvenc", "-profile:v", "main10", str(out)], capture_output=True)
    return out if r.returncode == 0 else None


def test_ten_bit_hevc_uses_hardware_path(tmp_path, profile):
    """M1: 10-bit (p010) hardware surfaces must also be downloadable instead of always failing and falling back to software. Requires NVENC to create the test file."""
    v = _nvenc_10bit(tmp_path)
    if v is None:
        pytest.skip("hevc_nvenc is unavailable; cannot create 10-bit HEVC")
    fs = FrameStream(str(v), profile, codec="hevc")
    assert len(list(fs)) == 8
    if not fs.used_hwaccel:
        pytest.skip("D3D11VA hardware decoding is unavailable on this machine")


def test_stretched_4_3_banner_is_restored_to_reference_layout(tmp_path, profile, knock_banner_png):
    import cv2
    import numpy as np
    from aditor.layout import parse_aspect
    v = make_video(tmp_path, "s.mp4", 2.0, overlay=(knock_banner_png, [(0.0, 2.0)]), game_height=1440)
    banner = cv2.imdecode(np.fromfile(str(knock_banner_png), np.uint8), cv2.IMREAD_COLOR)
    four = profile.with_layout(parse_aspect("4:3"))
    t, got, spec = next(iter(FrameStream(str(v), four)))
    assert got.shape == banner.shape and spec.shape == (profile.spec_roi[3], profile.spec_roi[2], 3)
    plain = next(iter(FrameStream(str(v), profile)))[1]
    def corr(a): return float(cv2.matchTemplate(a, banner, cv2.TM_CCOEFF_NORMED).max())
    assert corr(got) > 0.8 > corr(plain)
