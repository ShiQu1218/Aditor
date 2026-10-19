"""即時偵測（python -m aditor live）：讀 aditorrec 共享記憶體的小圖 → 擊殺事件與對局起訖（規格 §3.3–§3.5）。

輸入：aditorrec 的具名 file mapping（版面見 recorder/src/shm.rs 檔頭）：4 fps 的 banner／spec（BGR24，與 decode.py
相同的 1920×1080 基準裁切），每 4 格帶一張 640×360 GRAY8 thumb（1 fps）。
輸出：stdout 每行一個 JSON（ready／snapshot／match_pending／match_cancel／match_start／match_end／stats／error；見計畫 7 合約 1）。
stdin 收到 EOF 或 {"cmd":"stop"} → 收尾、送出最終 snapshot、exit 0。

擊殺偵測與離線分析一致：沿用 Detector／EventTracker／derive。離線版先掃一遍校準圖示尺度（calibrate）、
再邊解碼邊學關鍵字（analyze._Learner）；live 版兩者都「邊收邊做」：
1. 校準期：每格算多尺度圖示特徵，收集加分橫幅命中（與 calibrate._collect 相同的初篩與命中條件），
   達 WANTED_HITS 個或掃滿 CALIB_MAX_SCAN_SECONDS 後以 pick_scale 決定尺度。期間只保留「任一候選尺度下可能有橫幅」
   的格子（無損 PNG 壓縮），其餘格只記觀戰旗標（任一尺度都必定判為沒有橫幅，見 _Calibration.feed）；
   決定尺度後把緩衝補跑一次。
2. 學關鍵字期：與 analyze.work 的單段流程相同（AnchorCollector 蒐集 [0, LEARN_SCAN_SECONDS) 的錨點，需要關鍵字的
   格子先緩衝為 Pending，學完再定案）；期間另用「不驗證關鍵字」的暫定追蹤器提供暫定 snapshot。
"""
from __future__ import annotations

import json
import struct
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from . import ENGINE_VERSION
from .calibrate import (LEARN_SCAN_SECONDS, PROBE_MIN, WANTED_HITS, AnchorCollector, build_keywords,
                        pick_scale)
from .decode import FPS
from .derive import derive
from .detect import Detector, Pending
from .events import STEP, EventTracker
from .icon_detect import DEFAULT_SCALES, IconDetector, IconFrame
from .matches import MatchTracker
from .models import Event, FrameResult, SpecInterval
from .profile import Profile, load_profile
from .scene import SCENE_SIZE, SceneDetector

# ---- 共享記憶體版面（recorder/src/shm.rs） ----
SHM_MAGIC = b"APXSHM01"
SHM_VERSION = 1
SHM_SLOTS = 16
SHM_HEADER_BYTES = 64
SLOT_HEAD_BYTES = 24        # seq_begin(u64) + pts(i64) + has_thumb(u32) + reserved(u32)
LATEST_SEQ_OFFSET = 48
PTS_PER_SECOND = 10_000_000  # pts 為 100 ns tick

# ---- 讀取節奏 ----
MAX_LAG_SLOTS = 16          # 未讀槽數超過這麼多（最舊的已被覆寫）→ 跳到最新
START_BACKLOG_SLOTS = 8     # 開啟時最多補讀這麼多個已寫好的槽（再舊的可能正被覆寫）
POLL_INTERVAL = 0.05        # 沒有新槽時的等待秒數（槽間隔約 0.25 秒）
SNAPSHOT_INTERVAL = 1.0     # snapshot 至多每秒一次（實際時間）
STATS_INTERVAL = 5.0        # stats 每 5 秒（實際時間）

# ---- 邊收邊做的緩衝上限 ----
CALIB_MAX_SCAN_SECONDS = 600.0          # 同 calibrate() 的 max_scan_seconds：掃滿仍不足 WANTED_HITS 就用現有命中決定
CALIB_BUFFER_MAX_BYTES = 64 * 1024 * 1024   # 校準期緩衝的 PNG 位元組上限（約 400 格橫幅）；超過就提早決定尺度
PENDING_BUFFER_MAX_BYTES = 64 * 1024 * 1024  # 學關鍵字期待驗證格（Pending 筆畫圖）的位元組上限；超過就提早學完
# 跳過／撕裂的槽占全部影格的比例超過這個值，就不能保證結果等同離線分析
MAX_LOSS_RATIO = 0.01
PNG_LEVEL = 1               # 校準期緩衝的 PNG 壓縮等級（快；無損）

_EPS = 1e-6


class LayoutError(Exception):
    """共享記憶體檔頭不符（magic／版本／尺寸）。"""


@dataclass(frozen=True)
class ShmLayout:
    banner: tuple[int, int]   # (w, h)
    spec: tuple[int, int]
    thumb: tuple[int, int]

    @property
    def banner_bytes(self) -> int:
        return self.banner[0] * self.banner[1] * 3

    @property
    def spec_bytes(self) -> int:
        return self.spec[0] * self.spec[1] * 3

    @property
    def thumb_bytes(self) -> int:
        return self.thumb[0] * self.thumb[1]

    @property
    def slot_size(self) -> int:
        """與 shm.rs Sizes::new 相同：槽頭 24 + 資料 + seq_end 8，向上對齊 8。"""
        return (self.banner_bytes + self.spec_bytes + self.thumb_bytes + 32 + 7) & ~7

    @property
    def total_size(self) -> int:
        return SHM_HEADER_BYTES + SHM_SLOTS * self.slot_size


@dataclass
class Slot:
    seq: int
    pts: int
    banner: np.ndarray        # (h, w, 3) BGR
    spec: np.ndarray          # (h, w, 3) BGR
    thumb: np.ndarray | None  # (h, w) GRAY8；has_thumb=0 時為 None


def parse_header(buf, size: int) -> ShmLayout:
    """驗證檔頭並回傳版面；不符丟出 LayoutError。size＝可讀的映射大小。"""
    if size < SHM_HEADER_BYTES:
        raise LayoutError("共享記憶體小於檔頭大小")
    if bytes(buf[0:8]) != SHM_MAGIC:
        raise LayoutError("共享記憶體 magic 不符")
    version, slots, slot_size, bw, bh, sw, sh, tw, th = struct.unpack_from("<9I", buf, 8)
    if version != SHM_VERSION:
        raise LayoutError(f"不支援的共享記憶體版本：{version}")
    if slots != SHM_SLOTS:
        raise LayoutError(f"槽數不符：{slots}")
    if min(bw, bh, sw, sh, tw, th) <= 0:
        raise LayoutError("小圖尺寸必須大於 0")
    layout = ShmLayout((bw, bh), (sw, sh), (tw, th))
    if slot_size != layout.slot_size:
        raise LayoutError(f"槽大小不符：{slot_size} ≠ {layout.slot_size}")
    if layout.total_size > size:
        raise LayoutError("共享記憶體小於版面所需大小")
    return layout


class ShmReader:
    """共享記憶體讀端（規則見 shm.rs：讀 seq_end → 複製 → 讀 seq_begin，兩者都等於預期且非 0 才有效）。
    不保留槽內資料的參照：read 回傳的陣列都是複本。"""

    def __init__(self, buf: memoryview, size: int, on_close: Callable[[], None] | None = None):
        self._buf = buf
        self._on_close = on_close
        self.layout = parse_header(buf, size)

    @classmethod
    def open(cls, name: str) -> "ShmReader":
        """以 OpenFileMappingW 唯讀開啟（不會建立新的 mapping）。失敗丟出 OSError，版面不符丟出 LayoutError。"""
        mapping = _WinMapping(name)
        try:
            return cls(mapping.view, mapping.size, mapping.close)
        except BaseException:
            mapping.close()
            raise

    def _u64(self, offset: int) -> int:
        return struct.unpack_from("<Q", self._buf, offset)[0]

    def _slot_offset(self, seq: int) -> int:
        return SHM_HEADER_BYTES + ((seq - 1) % SHM_SLOTS) * self.layout.slot_size

    def latest(self) -> int:
        return self._u64(LATEST_SEQ_OFFSET)

    def peek_pts(self, seq: int) -> int | None:
        """只讀某槽的 pts（同樣驗證序號）；撕裂回傳 None。"""
        off = self._slot_offset(seq)
        if seq <= 0 or self._u64(off + self.layout.slot_size - 8) != seq:
            return None
        pts = struct.unpack_from("<q", self._buf, off + 8)[0]
        return pts if self._u64(off) == seq else None

    def read(self, seq: int) -> Slot | None:
        """複製 seq 號槽；撕裂（正被覆寫或已被更新的序號取代）回傳 None。"""
        if seq <= 0:
            return None
        lay = self.layout
        off = self._slot_offset(seq)
        if self._u64(off + lay.slot_size - 8) != seq:
            return None
        pts, has_thumb = struct.unpack_from("<qI", self._buf, off + 8)
        a = off + SLOT_HEAD_BYTES
        b = a + lay.banner_bytes
        c = b + lay.spec_bytes
        banner = np.frombuffer(self._buf[a:b], np.uint8).copy()
        spec = np.frombuffer(self._buf[b:c], np.uint8).copy()
        thumb = np.frombuffer(self._buf[c:c + lay.thumb_bytes], np.uint8).copy() if has_thumb else None
        if self._u64(off) != seq:
            return None  # 複製期間寫端開始覆寫這一槽
        return Slot(seq, pts,
                    banner.reshape(lay.banner[1], lay.banner[0], 3),
                    spec.reshape(lay.spec[1], lay.spec[0], 3),
                    None if thumb is None else thumb.reshape(lay.thumb[1], lay.thumb[0]))

    def close(self) -> None:
        buf, self._buf = self._buf, None
        if buf is not None:
            buf.release()
        if self._on_close is not None:
            self._on_close()
            self._on_close = None


class _WinMapping:
    """OpenFileMappingW（FILE_MAP_READ）＋MapViewOfFile 的最小包裝；view 是唯讀 memoryview。"""

    FILE_MAP_READ = 0x0004

    def __init__(self, name: str):
        if sys.platform != "win32":
            raise OSError("共享記憶體讀端只支援 Windows")
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenFileMappingW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
        k32.OpenFileMappingW.restype = wintypes.HANDLE
        k32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.c_size_t]
        k32.MapViewOfFile.restype = ctypes.c_void_p
        k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
        k32.UnmapViewOfFile.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.CloseHandle.restype = wintypes.BOOL

        class _MBI(ctypes.Structure):
            _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                        ("AllocationProtect", wintypes.DWORD), ("PartitionId", wintypes.WORD),
                        ("RegionSize", ctypes.c_size_t), ("State", wintypes.DWORD),
                        ("Protect", wintypes.DWORD), ("Type", wintypes.DWORD)]

        k32.VirtualQuery.argtypes = [ctypes.c_void_p, ctypes.POINTER(_MBI), ctypes.c_size_t]
        k32.VirtualQuery.restype = ctypes.c_size_t
        self._k32 = k32
        self._handle = k32.OpenFileMappingW(self.FILE_MAP_READ, False, name)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self._addr = k32.MapViewOfFile(self._handle, self.FILE_MAP_READ, 0, 0, 0)
        if not self._addr:
            err = ctypes.WinError(ctypes.get_last_error())
            k32.CloseHandle(self._handle)
            raise err
        mbi = _MBI()
        if not k32.VirtualQuery(self._addr, ctypes.byref(mbi), ctypes.sizeof(mbi)):
            err = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise err
        self.size = int(mbi.RegionSize)
        self.view = memoryview((ctypes.c_ubyte * self.size).from_address(self._addr)).cast("B")

    def close(self) -> None:
        if getattr(self, "_addr", None):
            self._k32.UnmapViewOfFile(self._addr)
            self._addr = None
        if getattr(self, "_handle", None):
            self._k32.CloseHandle(self._handle)
            self._handle = None


def _png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, PNG_LEVEL])
    if not ok:
        raise RuntimeError("PNG 編碼失敗")
    return buf.tobytes()


def _unpng(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise RuntimeError("PNG 解碼失敗")
    return img


def _empty(spectating: bool) -> FrameResult:
    """與 Detector.prepare 對「沒有橫幅跡象」的格子產出的結果相同。"""
    return FrameResult(None, 0.0, 0, False, None, spectating)


class _Calibration:
    """校準期：與 calibrate._collect 相同的命中條件（尺度 1.0 箭頭初篩 ≥ PROBE_MIN，多尺度特徵有箭頭與「+」）。"""

    def __init__(self, profile: Profile, max_scan: float, max_bytes: int):
        self.probe = IconDetector(profile.dir, scales=(1.0,))
        self.multi = IconDetector(profile.dir, scales=DEFAULT_SCALES)
        self.spec_det = Detector(profile)  # 只用觀戰判斷（與圖示尺度無關）
        self.max_scan, self.max_bytes = max_scan, max_bytes
        self.hits: list[float] = []
        self.scanned = 0.0
        # (t, 觀戰, banner PNG, spec PNG)；PNG 為 None＝任一候選尺度下都沒有橫幅跡象
        self.frames: list[tuple[float, bool, bytes | None, bytes | None]] = []
        self.bytes = 0

    def feed(self, t: float, banner: np.ndarray, spec: np.ndarray) -> bool:
        """回傳是否已可決定尺度。"""
        p = self.multi.p
        f = self.multi.features(banner)
        self.scanned += 1.0 / FPS
        if (self.probe.chev_best(banner)[0] >= PROBE_MIN and f.chev >= p.chev_min and f.plus >= p.plus_min):
            self.hits.append(f.chev_scale)
        # 多尺度特徵的分數是各候選尺度的最大值：箭頭全部 < chev_min 且（此時才會計算的）骷髏／握手全部 < left_min，
        # 則任一候選尺度的 Detector 都判為沒有橫幅、也沒有 cont 提示（見 IconDetector.features／classify）。
        if f.chev >= p.chev_min or max(f.skull, f.hand) >= p.left_min:
            b, s = _png(banner), _png(spec)
            self.bytes += len(b) + len(s)
            self.frames.append((t, False, b, s))
        else:
            self.frames.append((t, self.spec_det._spectating(spec), None, None))
        return (len(self.hits) >= WANTED_HITS or self.scanned >= self.max_scan - _EPS
                or self.bytes > self.max_bytes)


class LiveKills:
    """擊殺偵測：邊收邊校準圖示尺度、邊收邊學關鍵字；結果與離線 analyze（單段）一致。"""

    def __init__(self, profile: Profile, *, calib_max_scan: float = CALIB_MAX_SCAN_SECONDS,
                 calib_max_bytes: int = CALIB_BUFFER_MAX_BYTES, learn_seconds: float = LEARN_SCAN_SECONDS,
                 pending_max_bytes: int = PENDING_BUFFER_MAX_BYTES,
                 log: Callable[[str], None] | None = None):
        self.profile = profile
        self._learn_hi = learn_seconds
        self._pending_max = pending_max_bytes
        self._log = log or (lambda msg: None)
        self._calib: _Calibration | None = _Calibration(profile, calib_max_scan, calib_max_bytes)
        self.h_scale: float | None = None
        self.detector: Detector | None = None
        self.tracker: EventTracker | None = None
        self._col: AnchorCollector | None = None
        self._buf: list[tuple[float, FrameResult | Pending]] | None = None  # 關鍵字學完前的緩衝
        self._buf_bytes = 0
        self._provisional: EventTracker | None = None  # 學關鍵字期的暫定追蹤器（不驗證關鍵字）
        self.keywords = None
        # 與離線分析可能不同的原因（緩衝上限觸發的提早決定）；空＝與離線單段分析等價
        self.degraded: list[str] = []
        self.revision = 0  # 每餵一格 +1：snapshot 只在有變化時才需要重算

    @property
    def phase(self) -> str:
        if self._calib is not None:
            return "calibrating"
        return "learning" if self._buf is not None else "detecting"

    def feed(self, t: float, banner: np.ndarray, spec: np.ndarray) -> None:
        self.revision += 1
        if self._calib is not None:
            if self._calib.feed(t, banner, spec):
                self._calibrated()
            return
        self._detect(t, banner, spec)

    def _calibrated(self) -> None:
        cal, self._calib = self._calib, None
        self.h_scale = pick_scale(cal.hits)
        if cal.bytes > cal.max_bytes:
            self.degraded.append("calib_buffer_cap")
        self._log(f"圖示尺度 {self.h_scale}（命中 {len(cal.hits)} 格，掃描 {cal.scanned:.1f} 秒，"
                  f"緩衝 {len(cal.frames)} 格／{cal.bytes // 1024} KB）")
        self.detector = Detector(self.profile, self.h_scale)
        self.tracker = EventTracker(self.profile)
        self._col = AnchorCollector(self.profile, self.detector)
        self._buf, self._buf_bytes = [], 0
        self._provisional = EventTracker(self.profile)
        for t, spectating, b, s in cal.frames:
            if b is None:
                self._route(t, None, _empty(spectating), None)
            else:
                self._detect(t, _unpng(b), _unpng(s))

    def _detect(self, t: float, banner: np.ndarray, spec: np.ndarray) -> None:
        r, f = self.detector.prepare(banner, spec)
        self._route(t, banner, r, f)

    def _route(self, t: float, banner: np.ndarray | None, r: FrameResult | Pending, f: IconFrame | None) -> None:
        """與 analyze.work 的單段流程相同：蒐集錨點 → 學完就定案緩衝 → 本格直接定案或進緩衝。"""
        if self._col is not None:
            if t < self._learn_hi - _EPS and f is not None:
                self._col.feed_features(t, banner, f)
            if t >= self._learn_hi - _EPS or self._col.full(t):
                self._learned()
        if self._buf is None:
            self.tracker.feed(t, self.detector.resolve(r))
            return
        self._buf.append((t, r))
        self._provisional.feed(t, self.detector.resolve(r))  # 尚無關鍵字：resolve 不驗證
        if isinstance(r, Pending):
            self._buf_bytes += r.ink.nbytes
            if self._buf_bytes > self._pending_max:
                self._log("待驗證緩衝已達上限，提早學關鍵字")
                self.degraded.append("pending_buffer_cap")
                self._learned()

    def _learned(self) -> None:
        col, self._col = self._col, None
        if col is None:
            return
        self.keywords = build_keywords([col])
        self.detector.set_keywords(self.keywords)
        buf, self._buf, self._provisional = self._buf, None, None
        self._log(f"關鍵字學習完成（緩衝 {len(buf or [])} 格）")
        for bt, br in buf or []:
            self.tracker.feed(bt, self.detector.resolve(br))

    def snapshot(self) -> tuple[list[Event], list[SpecInterval]]:
        """目前的事件（已 derive）與觀戰區間；校準期為空，學關鍵字期為暫定結果。"""
        src = self._provisional if self._buf is not None else self.tracker
        if src is None:
            return [], []
        events, spec = src.snapshot()
        return derive(events, spec, self.profile), spec

    def finish(self) -> tuple[list[Event], list[SpecInterval]]:
        """串流結束：未決定尺度就以現有命中決定（同離線掃完仍不足的情況），未學完關鍵字就以現有錨點學。"""
        if self._calib is not None:
            self._calibrated()
        self._learned()
        events, spec = self.tracker.finish()
        return derive(events, spec, self.profile), list(spec)


class LiveEngine:
    """輪詢共享記憶體並把每槽交給擊殺偵測（banner／spec）與對局切分（thumb）；事件經 emit 送出。"""

    def __init__(self, reader: ShmReader, profile: Profile, scene: SceneDetector,
                 emit: Callable[[dict], None], *, clock: Callable[[], float] = time.monotonic,
                 log: Callable[[str], None] | None = None, kills: LiveKills | None = None):
        self.reader = reader
        self.scene = scene
        self.emit = emit
        self.clock = clock
        self.kills = kills or LiveKills(profile, log=log)
        self.matches = MatchTracker(sample_period=1.0)
        self.next_seq: int | None = None
        self.last_t: float | None = None
        self.last_pts: int | None = None
        self.frames = self.skipped = self.torn = 0
        self.cpu_total = 0.0
        self._win_frames, self._win_cpu = 0, 0.0
        now = clock()
        self._last_stats = now
        self._last_snap = now - SNAPSHOT_INTERVAL
        self._snap_rev = -1
        # snapshot 只在事件清單有變化時送出：初始視為「已送出空清單」（收尾時一定送出最終 snapshot）
        self._snap_doc = self._snapshot_doc([], [])[1]

    # ---- 讀取 ----
    def poll(self) -> int:
        """處理目前所有可讀的槽；回傳處理的格數（0＝沒有新槽）。"""
        n = 0
        while True:
            latest = self.reader.latest()
            if latest == 0:
                break
            if self.next_seq is None:
                self.next_seq = max(1, latest - START_BACKLOG_SLOTS + 1)
            if latest < self.next_seq:
                break
            if latest - self.next_seq + 1 > MAX_LAG_SLOTS:
                self.skipped += latest - self.next_seq
                self.next_seq = latest
            seq = self.next_seq
            self.next_seq += 1
            slot = self.reader.read(seq)
            if slot is None:
                self.torn += 1
                continue
            if self._process(slot):
                n += 1
        self.tick()
        return n

    def _grid_time(self, pts: int) -> float | None:
        """pts → 0.25 秒格線上的時間（EventTracker 以 STEP 判斷連續格）；寫端快於 4 fps 的多餘格回傳 None。"""
        raw = max(0.0, pts / PTS_PER_SECOND)
        t = round(raw / STEP) * STEP
        if self.last_t is not None and t <= self.last_t + _EPS:
            t = self.last_t + STEP
            if t - raw > STEP + _EPS:
                return None
        return t

    def _process(self, slot: Slot) -> bool:
        t = self._grid_time(slot.pts)
        if t is None:
            self.skipped += 1
            return False
        cpu0 = time.process_time()
        self.kills.feed(t, slot.banner, slot.spec)
        if slot.thumb is not None:
            for ev in self.matches.feed(t, self.scene.classify(slot.thumb)):
                self.emit({"ev": ev.type, "t": ev.t, "reason": ev.reason})
        cpu = time.process_time() - cpu0
        self.last_t, self.last_pts = t, slot.pts
        self.frames += 1
        self.cpu_total += cpu
        self._win_frames += 1
        self._win_cpu += cpu
        return True

    # ---- 定時輸出 ----
    def tick(self) -> None:
        now = self.clock()
        if now - self._last_snap >= SNAPSHOT_INTERVAL:
            self._last_snap = now
            self._snapshot(force=False)
        if now - self._last_stats >= STATS_INTERVAL:
            self._last_stats = now
            self._stats()

    def _snapshot(self, force: bool, final: tuple | None = None, quality: dict | None = None) -> None:
        if not force and self.kills.revision == self._snap_rev:
            return
        self._snap_rev = self.kills.revision
        events, spec = final if final is not None else self.kills.snapshot()
        body, doc = self._snapshot_doc(events, spec)
        if not force and doc == self._snap_doc:
            return
        self._snap_doc = doc
        if quality is not None:
            body = {**body, "final": True, "quality": quality}
        self.emit({"ev": "snapshot", "t": self.last_t or 0.0, **body})

    @staticmethod
    def _snapshot_doc(events: list[Event], spec: list[SpecInterval]) -> tuple[dict, str]:
        body = {"events": [e.to_dict() for e in events], "spectating": [s.to_dict() for s in spec]}
        return body, json.dumps(body, ensure_ascii=False, sort_keys=True)

    def lag_seconds(self) -> float:
        latest = self.reader.latest()
        if self.last_pts is None or latest == 0:
            return 0.0
        pts = self.reader.peek_pts(latest)
        return max(0.0, (pts - self.last_pts) / PTS_PER_SECOND) if pts is not None else 0.0

    def _stats(self) -> None:
        per = 1000.0 * self._win_cpu / self._win_frames if self._win_frames else 0.0
        self._win_frames, self._win_cpu = 0, 0.0
        self.emit({"ev": "stats", "t": self.last_t or 0.0, "frames": self.frames, "skipped": self.skipped,
                   "torn": self.torn, "lag_s": round(self.lag_seconds(), 3),
                   "cpu_ms_per_frame": round(per, 3)})

    def finish(self) -> None:
        """收尾：EventTracker.finish、MatchTracker.finish(最後時間)，送出對局事件、stats 與最終 snapshot。"""
        final = self.kills.finish()
        for ev in self.matches.finish(self.last_t or 0.0):
            self.emit({"ev": ev.type, "t": ev.t, "reason": ev.reason})
        self._stats()
        self._snapshot(force=True, final=final, quality=self.quality())

    def quality(self) -> dict:
        """最終結果是否可直接當作分析結果（等同離線）：沒有緩衝上限觸發、跳過與撕裂的槽夠少。"""
        reasons = list(self.kills.degraded)
        lost = self.skipped + self.torn
        if self.frames and lost / (self.frames + lost) > MAX_LOSS_RATIO:
            reasons.append("frames_lost")
        return {"complete": not reasons, "reasons": reasons, "h_scale": self.kills.h_scale,
                "frames": self.frames, "skipped": self.skipped, "torn": self.torn}


def _check_layout(layout: ShmLayout, profile: Profile) -> None:
    """小圖尺寸必須與設定檔 ROI 相同（aditorrec 以 1920×1080 基準裁切），thumb 必須足夠場景判斷。"""
    if layout.banner != tuple(profile.banner_roi[2:]) or layout.spec != tuple(profile.spec_roi[2:]):
        raise LayoutError(f"banner／spec 尺寸 {layout.banner}／{layout.spec} 與設定檔 ROI 不符")
    if layout.thumb[0] < SCENE_SIZE[0] or layout.thumb[1] < SCENE_SIZE[1]:
        raise LayoutError(f"thumb {layout.thumb} 小於場景判斷所需的 {SCENE_SIZE}")


class _Out:
    def __init__(self, stream):
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, obj: dict) -> None:
        line = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        with self._lock:
            self._stream.write(line)
            self._stream.flush()


def _log(msg: str) -> None:
    print(f"[live] {msg}", file=sys.stderr, flush=True)


def _watch_stdin(stdin, stop: threading.Event) -> None:
    """stdin EOF 或一行 {"cmd":"stop"} → 設定 stop；其他行忽略（記在 stderr）。"""
    try:
        for raw in stdin:
            line = raw.decode("utf-8", errors="replace").strip() if isinstance(raw, bytes) else raw.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except ValueError:
                _log(f"忽略無法解析的指令：{line[:200]}")
                continue
            if isinstance(req, dict) and req.get("cmd") == "stop":
                break
            _log(f"忽略未知指令：{line[:200]}")
    except (OSError, ValueError) as e:
        _log(f"stdin 讀取失敗，視為停止：{e}")
    finally:
        stop.set()


def run(shm: str, profile_dir: Path, scene_dir: Path | None = None, *, stdin=None, stdout=None,
        poll_interval: float = POLL_INTERVAL) -> int:
    out = _Out(stdout if stdout is not None else sys.stdout.buffer)
    stdin = stdin if stdin is not None else sys.stdin.buffer
    try:
        profile = load_profile(Path(profile_dir))
        scene = SceneDetector(Path(scene_dir) if scene_dir else None)
    except Exception as e:  # noqa: BLE001
        out.send({"ev": "error", "code": "internal", "message": f"載入範本失敗：{e}"})
        return 1
    try:
        reader = ShmReader.open(shm)
    except LayoutError as e:
        out.send({"ev": "error", "code": "bad_layout", "message": str(e)})
        return 1
    except OSError as e:
        out.send({"ev": "error", "code": "shm_open_failed", "message": f"無法開啟共享記憶體 {shm}：{e}"})
        return 1
    try:
        try:
            _check_layout(reader.layout, profile)
        except LayoutError as e:
            out.send({"ev": "error", "code": "bad_layout", "message": str(e)})
            return 1
        lay = reader.layout
        out.send({"ev": "ready", "engine_version": ENGINE_VERSION, "banner": list(lay.banner),
                  "spec": list(lay.spec), "thumb": list(lay.thumb)})
        stop = threading.Event()
        threading.Thread(target=_watch_stdin, args=(stdin, stop), daemon=True).start()
        engine = LiveEngine(reader, profile, scene, out.send, log=_log)
        try:
            while not stop.is_set():
                if engine.poll() == 0:
                    stop.wait(poll_interval)
            engine.poll()  # 停止前已寫好的槽
            engine.finish()
        except Exception as e:  # noqa: BLE001
            out.send({"ev": "error", "code": "internal", "message": f"{type(e).__name__}: {e}"})
            return 1
        return 0
    finally:
        reader.close()
