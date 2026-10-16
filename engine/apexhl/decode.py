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


def build_filter(profile: Profile, gpu: bool = False, hw_format: str = "nv12") -> str:
    """hw_format：hwdownload 後的像素格式。8-bit 解碼表面是 nv12；10-bit（HEVC Main10／AV1 10-bit，
    HDR 錄影常見）是 p010le。ffmpeg 的 format 濾鏡只會取第一個候選，所以無法寫成 nv12|p010le，
    改由 FrameStream 在第一格前失敗時換格式重試。"""
    bx, by, bw, bh = profile.banner_roi
    sx, sy, sw, sh = profile.spec_roi
    pre = f"fps={FPS},hwdownload,format={hw_format}" if gpu else f"fps={FPS}"
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
    """硬體解碼的 ffmpeg 失敗（用於回退軟體）。k = 失敗前已產出的畫格數（0 = 第一格前就失敗）。"""

    def __init__(self, k: int = 0):
        super().__init__(k)
        self.k = k


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
        self._hw_format = "nv12"

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

    def _spawn(self, hwaccel: bool, start: float | None = None) -> subprocess.Popen:
        start = self.start if start is None else start
        cmd = [ffbin.ffmpeg(), "-v", LOGLEVEL, "-nostdin"]
        cmd += build_input_args(self.codec, hwaccel, start)
        cmd += ["-i", self.path, "-filter_complex", build_filter(self.profile, is_gpu_path(self.codec, hwaccel), self._hw_format)]
        if self.end is not None:
            cmd += ["-t", f"{max(self.end - start, 0.0):.3f}"]
        cmd += ["-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"]
        with self._lock:
            self._stderr.clear()
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        threading.Thread(target=self._drain_stderr, args=(proc.stderr,), daemon=True).start()
        return proc

    def _frames(self, hwaccel: bool, k0: int = 0) -> Iterator[tuple[float, np.ndarray, np.ndarray]]:
        """k0：已由先前（失敗的）硬體解碼產出的畫格數；從 start + k0/FPS 重新開始，時間格線不變。"""
        bx, by, bw, bh = self.profile.banner_roi
        sx, sy, sw, sh = self.profile.spec_roi
        frame_bytes = bw * (bh + sh) * 3
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
            arr = np.frombuffer(buf, dtype=np.uint8)
            banner = arr[: bw * bh * 3].reshape(bh, bw, 3).copy()
            spec = arr[bw * bh * 3:].reshape(sh, bw, 3)[:, :sw].copy()
            yield self.start + k * (1.0 / FPS), banner, spec
            k += 1
        rc = proc.wait()
        if rc != 0 and not self._closed:
            if hwaccel or k == k0:
                raise _Failed(k)  # 硬體解碼中途失敗（TDR、裝置遺失）：從下一格改用軟體繼續（I7）
            raise DecodeError(f"ffmpeg 異常結束（{rc}）", self.stderr_tail)

    def __iter__(self) -> Iterator[tuple[float, np.ndarray, np.ndarray]]:
        """依序嘗試：硬體（nv12）→ 硬體（p010le，僅限第一格前就失敗＝像素格式不符的 10-bit 影片）→ 軟體。
        硬體在中途失敗時，從尚未產出的那一格起改用軟體繼續（時間格線不變）。"""
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
                    continue  # 已經解出畫格 → 不是像素格式問題，直接退回軟體
                self._hw_format, self.used_hwaccel = fmt, hw
                try:
                    yield from self._frames(hw, k0)
                    return
                except _Failed as f:
                    k0 = f.k
                    if i == len(plans) - 1:
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
