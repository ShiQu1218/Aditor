"""ffmpeg decode pipeline (spec §5.1): reduce frame rate → scale to 1080p → crop two regions → vstack → bgr24 rawvideo.

The crops are the profile capture rects; Profile.restore turns them into reference-layout banner/spec images (layout.py)."""
from __future__ import annotations

import subprocess
import threading
from typing import Iterator

import numpy as np
import cv2

from . import ffbin
from .profile import Profile

HWACCEL_ARGS = ["-hwaccel", "auto"]
# FFmpeg defaults to libdav1d for AV1, which ignores -hwaccel; specify the native AV1 decoder to use D3D11VA.
# Hardware path: keep frames on the GPU (d3d11 surface) and hwdownload only after fps sampling to avoid a GPU-to-CPU copy per frame.
GPU_HWACCEL_ARGS = ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"]
AV1_HWACCEL_ARGS = GPU_HWACCEL_ARGS + ["-c:v", "av1"]
GPU_CODECS = ("av1", "h264", "hevc", "vp9")
LOGLEVEL = "error"
FPS = 4
STDERR_LIMIT = 64 * 1024


class DecodeError(Exception):
    def __init__(self, message: str, stderr_tail: str = ""):
        super().__init__(message)
        self.message = message
        self.stderr_tail = stderr_tail


def is_gpu_path(codec: str | None, hwaccel: bool) -> bool:
    """Whether to use the hardware path that keeps frames on the GPU (requires a known, supported codec)."""
    return bool(hwaccel and codec in GPU_CODECS)


def build_filter(profile: Profile, gpu: bool = False, hw_format: str = "nv12") -> str:
    """hw_format is the pixel format after hwdownload. The 8-bit decode surface is nv12; 10-bit (HEVC Main10/AV1 10-bit,
    common in HDR recordings) uses p010le. FFmpeg's format filter accepts only the first candidate, so nv12|p010le
    cannot be specified. FrameStream retries with another format if decoding fails before the first frame."""
    bx, by, bw, bh = profile.capture_banner
    sx, sy, sw, sh = profile.capture_spec
    # Match software decoder chroma conversion so faint HUD colours keep the same thresholds.
    planar = "yuv420p10le" if hw_format == "p010le" else "yuv420p"
    pre = f"fps={FPS},hwdownload,format={hw_format},format={planar}" if gpu else f"fps={FPS}"
    feed = getattr(profile, "capture_killfeed", None)
    if feed is not None:
        fx, fy, fw, fh = feed
        width = max(bw, sw, fw)
        return (f"[0:v]{pre},scale=1920:1080,split=4[a][b][c][d];"
                f"[a]crop={bw}:{bh}:{bx}:{by},pad={width}:ih[a1];"
                f"[b]crop={sw}:{sh}:{sx}:{sy},pad={width}:ih[b1];"
                f"[c]crop={fw}:{fh}:{fx}:{fy},pad={width}:ih[c1];"
                f"[d]scale=640:360,pad={width}:360[d1];[a1][b1][c1][d1]vstack=inputs=4")
    return (f"[0:v]{pre},scale=1920:1080,split[a][b];"
            f"[a]crop={bw}:{bh}:{bx}:{by}[a1];"
            f"[b]crop={sw}:{sh}:{sx}:{sy},pad={bw}:ih[b1];"
            f"[a1][b1]vstack")


def build_input_args(codec: str | None, hwaccel: bool, start: float) -> list[str]:
    """Analysis thread budgets and input options; decoder options and -ss must precede -i."""
    # Multiple analysis segments run beside the game; do not create a per-core pool in every FFmpeg process.
    args = ["-threads", "2", "-filter_threads", "1", "-filter_complex_threads", "1"]
    if is_gpu_path(codec, hwaccel):
        args += AV1_HWACCEL_ARGS if codec == "av1" else GPU_HWACCEL_ARGS
    elif hwaccel:
        args += HWACCEL_ARGS
    if start > 0:
        args += ["-ss", f"{start:.3f}"]
    return args


class _Failed(Exception):
    """FFmpeg hardware decoding failed (used to fall back to software). k is the number of frames produced before failure (0 means failure before the first frame)."""

    def __init__(self, k: int = 0):
        super().__init__(k)
        self.k = k


class FrameStream:
    """Iterable decoded stream yielding (t, banner_bgr, spec_bgr), where t = start + k * 0.25."""

    def __init__(self, path: str, profile: Profile, *, start: float = 0.0, hwaccel: bool = True,
                 codec: str | None = None, end: float | None = None):
        self.path = path
        self.end = end
        self.profile = profile
        self.start = start
        self.codec = codec
        self.used_hwaccel = hwaccel
        self._stderr = bytearray()
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._closed = False
        self._hw_format = "nv12"
        self.killfeed = None
        self.thumb = None

    @property
    def stderr_tail(self) -> str:
        with self._lock:
            return bytes(self._stderr).decode("utf-8", errors="replace")

    def _drain_stderr(self, pipe) -> None:
        try:
            while True:
                chunk = pipe.read(4096)
                if not chunk:
                    break
                with self._lock:
                    self._stderr += chunk
                    if len(self._stderr) > STDERR_LIMIT:
                        del self._stderr[:-STDERR_LIMIT]
        except (OSError, ValueError):
            pass
        finally:
            try:
                pipe.close()  # Release the pipe on EOF (the process has exited); this also prevents the old process's stderr from lingering during hardware fallback.
            except OSError:
                pass

    def _spawn(self, hwaccel: bool, start: float | None = None) -> subprocess.Popen:
        start = self.start if start is None else start
        cmd = [ffbin.ffmpeg(), "-v", LOGLEVEL, "-nostdin"]
        cmd += build_input_args(self.codec, hwaccel, start)
        cmd += ["-i", self.path, "-filter_complex", build_filter(self.profile, is_gpu_path(self.codec, hwaccel), self._hw_format)]
        if self.end is not None:
            cmd += ["-t", f"{max(self.end - start, 0.0):.3f}"]
        cmd += ["-pix_fmt", "bgr24", "-threads", "1", "-f", "rawvideo", "pipe:1"]
        with self._lock:
            self._stderr.clear()
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        threading.Thread(target=self._drain_stderr, args=(proc.stderr,), daemon=True).start()
        return proc

    def _frames(self, hwaccel: bool, k0: int = 0) -> Iterator[tuple[float, np.ndarray, np.ndarray]]:
        """k0 is the number of frames produced by the previous (failed) hardware decode; resume at start + k0/FPS to preserve the timeline grid."""
        bx, by, bw, bh = self.profile.capture_banner
        sx, sy, sw, sh = self.profile.capture_spec
        feed = getattr(self.profile, "capture_killfeed", None)
        fw, fh = feed[2:] if feed is not None else (0, 0)
        width = max(bw, sw, fw) if feed is not None else bw
        th = 360 if feed is not None else 0
        frame_bytes = width * (bh + sh + fh + th) * 3
        buf = bytearray(frame_bytes)
        view = memoryview(buf)
        self._proc = proc = self._spawn(hwaccel, self.start + k0 / FPS)
        k = k0
        while True:
            got = 0
            while got < frame_bytes:
                n = proc.stdout.readinto(view[got:])
                if not n:
                    break
                got += n
            if got < frame_bytes:
                break
            arr = np.frombuffer(buf, dtype=np.uint8).reshape(bh + sh + fh + th, width, 3)
            banner, spec = self.profile.restore(arr[:bh, :bw], arr[bh:bh + sh, :sw])
            self.killfeed = self.profile.restore_killfeed(arr[bh + sh:bh + sh + fh, :fw]).copy() if feed is not None else None
            if feed is not None:
                self.thumb = cv2.cvtColor(arr[-th:, :640], cv2.COLOR_BGR2GRAY)
            yield self.start + k * (1.0 / FPS), banner.copy(), spec.copy()
            k += 1
        rc = proc.wait()
        if rc != 0 and not self._closed:
            if hwaccel or k == k0:
                # Fallback starts a new FFmpeg process and replaces self._proc; close the exited process's stdout first to avoid leaking pipe handles.
                try:
                    proc.stdout.close()
                except OSError:
                    pass
                raise _Failed(k)  # Hardware decoding failed mid-stream (TDR or device loss): continue in software from the next frame (I7).
            raise DecodeError(f"ffmpeg exited unexpectedly ({rc})", self.stderr_tail)

    def __iter__(self) -> Iterator[tuple[float, np.ndarray, np.ndarray]]:
        """Try hardware (nv12), then hardware (p010le, only if failure occurs before the first frame, indicating an unsupported
        pixel format in a 10-bit video), then software. If hardware fails mid-stream, continue in software from the first
        frame not yet produced, preserving the timeline grid."""
        if self.used_hwaccel:
            plans = [(True, "nv12")]
            if is_gpu_path(self.codec, True):
                plans.append((True, "p010le"))
            plans.append((False, "nv12"))
        else:
            plans = [(False, "nv12")]
        k0 = 0
        try:
            for i, (hw, fmt) in enumerate(plans):
                if fmt == "p010le" and k0 > 0:
                    continue  # Frames were already decoded, so this is not a pixel-format issue; fall back to software.
                self._hw_format, self.used_hwaccel = fmt, hw
                try:
                    yield from self._frames(hw, k0)
                    return
                except _Failed as f:
                    k0 = f.k
                    if i == len(plans) - 1:
                        raise DecodeError("ffmpeg decoding failed", self.stderr_tail) from None
        finally:
            self.close()

    def close(self) -> None:
        self._closed = True
        p = self._proc
        if p is not None and p.poll() is None:
            p.kill()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if p is not None:
            for s in (p.stdout, p.stderr):
                try:
                    s and s.close()
                except OSError:
                    pass


def iter_frames(path: str, profile: Profile, *, start: float = 0.0,
                hwaccel: bool = True, codec: str | None = None, end: float | None = None) -> FrameStream:
    return FrameStream(path, profile, start=start, hwaccel=hwaccel, codec=codec, end=end)
