"""ffmpeg 解碼管線（spec §5.1）：降幀 → 縮放到 1080p → 兩路裁切 → vstack → bgr24 rawvideo。"""
from __future__ import annotations

import subprocess
import threading
from typing import Iterator

import numpy as np

from . import ffbin
from .profile import Profile

HWACCEL_ARGS = ["-hwaccel", "auto"]
# ffmpeg 預設用 libdav1d 解碼 AV1，該解碼器會忽略 -hwaccel；需指定原生 av1 解碼器才會走 D3D11VA。
# 硬體路徑：畫格留在 GPU（d3d11 surface），fps 抽樣後才 hwdownload，省下每格 GPU→CPU 複製。
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
    """是否走「畫格留在 GPU」的硬體路徑（需已知且支援的編碼）。"""
    return bool(hwaccel and codec in GPU_CODECS)


def build_filter(profile: Profile, gpu: bool = False) -> str:
    bx, by, bw, bh = profile.banner_roi
    sx, sy, sw, sh = profile.spec_roi
    pre = f"fps={FPS},hwdownload,format=nv12" if gpu else f"fps={FPS}"
    return (f"[0:v]{pre},scale=1920:1080,split[a][b];"
            f"[a]crop={bw}:{bh}:{bx}:{by}[a1];"
            f"[b]crop={sw}:{sh}:{sx}:{sy},pad={bw}:ih[b1];"
            f"[a1][b1]vstack")


def build_input_args(codec: str | None, hwaccel: bool, start: float) -> list[str]:
    """-i 之前的輸入選項（解碼器選項與 -ss 都必須在 -i 之前）。"""
    args: list[str] = []
    if is_gpu_path(codec, hwaccel):
        args += AV1_HWACCEL_ARGS if codec == "av1" else GPU_HWACCEL_ARGS
    elif hwaccel:
        args += HWACCEL_ARGS
    if start > 0:
        args += ["-ss", f"{start:.3f}"]
    return args


class _Failed(Exception):
    """第一格輸出前 ffmpeg 就失敗（用於硬體解碼回退）。"""


class FrameStream:
    """可迭代的解碼串流。產出 (t, banner_bgr, spec_bgr)，t = start + k * 0.25。"""

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

    def _spawn(self, hwaccel: bool) -> subprocess.Popen:
        cmd = [ffbin.ffmpeg(), "-v", LOGLEVEL, "-nostdin"]
        cmd += build_input_args(self.codec, hwaccel, self.start)
        cmd += ["-i", self.path, "-filter_complex", build_filter(self.profile, is_gpu_path(self.codec, hwaccel))]
        if self.end is not None:
            cmd += ["-t", f"{max(self.end - self.start, 0.0):.3f}"]
        cmd += ["-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"]
        with self._lock:
            self._stderr.clear()
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        threading.Thread(target=self._drain_stderr, args=(proc.stderr,), daemon=True).start()
        return proc

    def _frames(self, hwaccel: bool) -> Iterator[tuple[float, np.ndarray, np.ndarray]]:
        bx, by, bw, bh = self.profile.banner_roi
        sx, sy, sw, sh = self.profile.spec_roi
        frame_bytes = bw * (bh + sh) * 3
        buf = bytearray(frame_bytes)
        view = memoryview(buf)
        self._proc = proc = self._spawn(hwaccel)
        k = 0
        while True:
            got = 0
            while got < frame_bytes:
                n = proc.stdout.readinto(view[got:])
                if not n:
                    break
                got += n
            if got < frame_bytes:
                break
            arr = np.frombuffer(buf, dtype=np.uint8)
            banner = arr[: bw * bh * 3].reshape(bh, bw, 3).copy()
            spec = arr[bw * bh * 3:].reshape(sh, bw, 3)[:, :sw].copy()
            yield self.start + k * (1.0 / FPS), banner, spec
            k += 1
        rc = proc.wait()
        if rc != 0 and not self._closed:
            if k == 0:
                raise _Failed()
            raise DecodeError(f"ffmpeg 異常結束（{rc}）", self.stderr_tail)

    def __iter__(self) -> Iterator[tuple[float, np.ndarray, np.ndarray]]:
        try:
            try:
                yield from self._frames(self.used_hwaccel)
            except _Failed:
                if self.used_hwaccel:
                    # 硬體解碼在第一格前失敗 → 改用軟體解碼重試一次
                    self.used_hwaccel = False
                    try:
                        yield from self._frames(False)
                    except _Failed:
                        raise DecodeError("ffmpeg 解碼失敗", self.stderr_tail) from None
                else:
                    raise DecodeError("ffmpeg 解碼失敗", self.stderr_tail) from None
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
