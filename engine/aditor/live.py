"""Live detection (python -m aditor live): read small frames from aditorrec shared memory and emit kill events and match boundaries (spec §3.3–§3.5).

Input: aditorrec named file mapping (layout documented at the top of recorder/src/shm.rs): 4 fps banner/spec frames (BGR24,
cropped using the same 1920×1080 reference as decode.py), with one 640×360 GRAY8 thumbnail every four frames (1 fps).
Output: one JSON object per stdout line (ready/snapshot/match_pending/match_cancel/match_start/match_end/stats/error; see plan 7 contract 1).
On stdin EOF or {"cmd":"stop"}, finish, send the final snapshot, and exit 0.

Kill detection matches offline analysis by reusing Detector/EventTracker/derive. Offline processing first scans to calibrate icon
scale (calibrate), then learns keywords while decoding (analyze._Learner); live processing does both incrementally:
1. Calibration: compute multi-scale icon features for each frame and collect score-banner hits (same initial filter and hit
   conditions as calibrate._collect). Choose a scale with pick_scale after WANTED_HITS hits or CALIB_MAX_SCAN_SECONDS. Keep
   only frames that may contain a banner at any candidate scale (losslessly PNG-compressed); for other frames, retain only the
   spectating flag, since every scale necessarily classifies them as banner-free (see _Calibration.feed). Replay the buffer
   after selecting the scale.
2. Keyword learning: follow the single-segment analyze.work flow (AnchorCollector collects anchors in [0, LEARN_SCAN_SECONDS);
   buffer frames requiring keyword validation as Pending and finalize them after learning). A provisional tracker that skips
   keyword validation also provides provisional snapshots during this phase.
3. Extended learning: when templates are incomplete within the learning window (same as offline), retain per-frame logs and
   continue collecting anchors. Try to fill missing templates whenever another anchor banner arrives; when a template is added,
   re-finalize from the log and update the snapshot immediately. At shutdown, choose final templates from all anchors, matching
   offline results. Stop extended learning (degraded mode) if logs exceed LATE_REPLAY_MAX_BYTES.
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
                        extend_keywords, keywords_complete, pick_scale, same_keywords)
from .decode import FPS
from .derive import derive
from .detect import Detector, Pending
from .events import STEP, EventTracker
from .icon_detect import DEFAULT_SCALES, IconDetector, IconFrame
from .matches import MatchTracker
from .models import Event, FrameResult, SpecInterval
from .profile import Profile, load_profile
from .layout import Layout, parse_aspect
from .games import UnsupportedGame, require_analyzable, resolve_game
from .scene import SCENE_SIZE, SceneDetector

# ---- Shared-memory layout (recorder/src/shm.rs) ----
SHM_MAGIC = b"APXSHM01"
SHM_VERSION = 1
SHM_SLOTS = 16
SHM_HEADER_BYTES = 64
SLOT_HEAD_BYTES = 24        # seq_begin(u64) + pts(i64) + has_thumb(u32) + reserved(u32)
LATEST_SEQ_OFFSET = 48
PTS_PER_SECOND = 10_000_000  # PTS is measured in 100 ns ticks.

# ---- Read pacing ----
MAX_LAG_SLOTS = 16          # If more slots than this are unread (the oldest have been overwritten), jump to the latest slot.
START_BACKLOG_SLOTS = 8     # On startup, read at most this many written slots (older slots may be overwritten).
POLL_INTERVAL = 0.05        # Wait this many seconds when there is no new slot (slots are about 0.25 seconds apart).
SNAPSHOT_INTERVAL = 1.0     # Emit snapshots at most once per second of wall-clock time.
STATS_INTERVAL = 5.0        # Emit stats every 5 seconds of wall-clock time.

# ---- Buffer limits for incremental processing ----
CALIB_MAX_SCAN_SECONDS = 600.0          # Same as calibrate()'s max_scan_seconds: if WANTED_HITS is not reached, choose from existing hits.
CALIB_BUFFER_MAX_BYTES = 64 * 1024 * 1024   # Maximum PNG bytes buffered during calibration (~400 banner frames); select a scale early if exceeded.
PENDING_BUFFER_MAX_BYTES = 64 * 1024 * 1024  # Maximum bytes for pending keyword-validation frames (stroke images); finish learning early if exceeded.
LATE_REPLAY_MAX_BYTES = 128 * 1024 * 1024    # Maximum extended-learning frame log (~hours of recording); stop extended learning if exceeded.
FRAME_RECORD_BYTES = 400                     # Estimated fixed per-frame log overhead (FrameResult/Pending objects), excluding stroke images.
# If skipped/torn slots exceed this fraction of all frames, equivalence with offline analysis is no longer guaranteed.
MAX_LOSS_RATIO = 0.01
PNG_LEVEL = 1               # Fast, lossless PNG compression level for calibration buffering.

_EPS = 1e-6


class LayoutError(Exception):
    """Shared-memory header does not match (magic, version, or size)."""


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
        """Same layout as shm.rs Sizes::new: 24-byte slot header + data + 8-byte seq_end, rounded up to an 8-byte boundary."""
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
    thumb: np.ndarray | None  # (h, w) GRAY8; None when has_thumb=0.


def parse_header(buf, size: int) -> ShmLayout:
    """Validate the header and return the layout; raise LayoutError on mismatch. size is the readable mapping size."""
    if size < SHM_HEADER_BYTES:
        raise LayoutError("Shared memory is smaller than the header")
    if bytes(buf[0:8]) != SHM_MAGIC:
        raise LayoutError("Shared memory magic does not match")
    version, slots, slot_size, bw, bh, sw, sh, tw, th = struct.unpack_from("<9I", buf, 8)
    if version != SHM_VERSION:
        raise LayoutError(f"Unsupported shared memory version: {version}")
    if slots != SHM_SLOTS:
        raise LayoutError(f"Slot count does not match: {slots}")
    if min(bw, bh, sw, sh, tw, th) <= 0:
        raise LayoutError("Thumbnail dimensions must be greater than 0")
    layout = ShmLayout((bw, bh), (sw, sh), (tw, th))
    if slot_size != layout.slot_size:
        raise LayoutError(f"Slot size does not match: {slot_size} != {layout.slot_size}")
    if layout.total_size > size:
        raise LayoutError("Shared memory is smaller than the required layout")
    return layout


class ShmReader:
    """Shared-memory reader (see shm.rs for the protocol: read seq_end, copy, then read seq_begin; valid only when both match
    the expected nonzero value). Slot data is not referenced after reading; arrays returned by read are copies."""

    def __init__(self, buf: memoryview, size: int, on_close: Callable[[], None] | None = None):
        self._buf = buf
        self._on_close = on_close
        self.layout = parse_header(buf, size)

    @classmethod
    def open(cls, name: str) -> "ShmReader":
        """Open read-only with OpenFileMappingW (does not create a mapping). Raise OSError on failure and LayoutError on layout mismatch."""
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
        """Read only the PTS from a slot (validating the sequence as usual); return None if the slot is torn."""
        off = self._slot_offset(seq)
        if seq <= 0 or self._u64(off + self.layout.slot_size - 8) != seq:
            return None
        pts = struct.unpack_from("<q", self._buf, off + 8)[0]
        return pts if self._u64(off) == seq else None

    def read(self, seq: int) -> Slot | None:
        """Copy the slot with the given sequence; return None if torn (being overwritten or replaced by a newer sequence)."""
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
            return None  # The writer started overwriting this slot during the copy.
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
    """Minimal wrapper for OpenFileMappingW (FILE_MAP_READ) and MapViewOfFile; view is a read-only memoryview."""

    FILE_MAP_READ = 0x0004

    def __init__(self, name: str):
        if sys.platform != "win32":
            raise OSError("The shared memory reader only supports Windows")
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
        raise RuntimeError("PNG encoding failed")
    return buf.tobytes()


def _unpng(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise RuntimeError("PNG decoding failed")
    return img


def _empty(spectating: bool) -> FrameResult:
    """Return the same result as Detector.prepare for a frame with no banner evidence."""
    return FrameResult(None, 0.0, 0, False, None, spectating)


class _Calibration:
    """Calibration phase: use the same hit conditions as calibrate._collect (scale-1.0 chevron prefilter >= PROBE_MIN, then multi-scale chevron and plus features)."""

    def __init__(self, profile: Profile, max_scan: float, max_bytes: int):
        self.probe = IconDetector(profile.dir, scales=(1.0,))
        self.multi = IconDetector(profile.dir, scales=DEFAULT_SCALES)
        self.spec_det = Detector(profile)  # Used only for spectating classification (independent of icon scale).
        self.max_scan, self.max_bytes = max_scan, max_bytes
        self.hits: list[float] = []
        self.scanned = 0.0
        # (t, spectating, banner PNG, spec PNG); PNG is None when no candidate scale detects banner evidence.
        self.frames: list[tuple[float, bool, bytes | None, bytes | None]] = []
        self.bytes = 0

    def feed(self, t: float, banner: np.ndarray, spec: np.ndarray) -> bool:
        """Return whether the scale can now be selected."""
        p = self.multi.p
        f = self.multi.features(banner)
        self.scanned += 1.0 / FPS
        if (self.probe.chev_best(banner)[0] >= PROBE_MIN and f.chev >= p.chev_min and f.plus >= p.plus_min):
            self.hits.append(f.chev_scale)
        # Multi-scale feature scores are maxima across candidate scales: when all chevrons are < chev_min and (computed only
        # in that case) all skull/hand scores are < left_min, every candidate Detector classifies the frame as banner-free
        # with no cont hint (see IconDetector.features/classify).
        if f.chev >= p.chev_min or max(f.skull, f.hand) >= p.left_min:
            b, s = _png(banner), _png(spec)
            self.bytes += len(b) + len(s)
            self.frames.append((t, False, b, s))
        else:
            self.frames.append((t, self.spec_det._spectating(spec), None, None))
        return (len(self.hits) >= WANTED_HITS or self.scanned >= self.max_scan - _EPS
                or self.bytes > self.max_bytes)


class LiveKills:
    """Kill detection: calibrate icon scale and learn keywords incrementally; results match single-segment offline analyze."""

    def __init__(self, profile: Profile, *, calib_max_scan: float = CALIB_MAX_SCAN_SECONDS,
                 calib_max_bytes: int = CALIB_BUFFER_MAX_BYTES, learn_seconds: float = LEARN_SCAN_SECONDS,
                 pending_max_bytes: int = PENDING_BUFFER_MAX_BYTES, late_max_bytes: int = LATE_REPLAY_MAX_BYTES,
                 log: Callable[[str], None] | None = None):
        self.profile = profile
        self._learn_hi = learn_seconds
        self._pending_max = pending_max_bytes
        self._late_max = late_max_bytes
        # Extended learning (when templates are incomplete in the learning window): learning-window collectors, extension collectors, and per-frame logs.
        self._head_col: AnchorCollector | None = None
        self._head_kw = None
        self._late_col: AnchorCollector | None = None
        self._late_from = 0.0
        self._late_groups = 0
        self._replay: list[tuple[float, FrameResult | Pending]] | None = None
        self._replay_bytes = 0
        self._log = log or (lambda msg: None)
        self._calib: _Calibration | None = _Calibration(profile, calib_max_scan, calib_max_bytes)
        self.h_scale: float | None = None
        self.detector: Detector | None = None
        self.tracker: EventTracker | None = None
        self._col: AnchorCollector | None = None
        self._buf: list[tuple[float, FrameResult | Pending]] | None = None  # Buffer frames until keyword learning completes.
        self._buf_bytes = 0
        self._provisional: EventTracker | None = None  # Provisional tracker during keyword learning (skips keyword validation).
        self.keywords = None
        # Reasons results may differ from offline analysis (early decisions caused by buffer limits); empty means equivalent to single-segment offline analysis.
        self.degraded: list[str] = []
        self.revision = 0  # Incremented for each frame; recompute the snapshot only when this value changes.

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
        self._log(f"Icon scale {self.h_scale} ({len(cal.hits)} hits, scanned {cal.scanned:.1f} seconds, "
                  f"buffered {len(cal.frames)} frames / {cal.bytes // 1024} KB)")
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
        """Same single-segment flow as analyze.work: collect anchors, finalize buffered frames when learning completes, and either finalize this frame or buffer it."""
        if self._col is not None:
            if t < self._learn_hi - _EPS and f is not None:
                self._col.feed_features(t, banner, f)
            if t >= self._learn_hi - _EPS or self._col.full(t):
                self._learned(t)
        if self._buf is None:
            self.tracker.feed(t, self.detector.resolve(r))
            if self._replay is not None:
                self._late(t, banner, r, f)
            return
        self._buf.append((t, r))
        self._provisional.feed(t, self.detector.resolve(r))  # No keywords are available yet, so resolve skips validation.
        if isinstance(r, Pending):
            self._buf_bytes += r.ink.nbytes
            if self._buf_bytes > self._pending_max:
                self._log("Pending validation buffer reached its limit; learning keywords early")
                self.degraded.append("pending_buffer_cap")
                self._learned(t)

    def _learned(self, t: float | None = None) -> None:
        """Finish the learning window (t is the triggering frame; None means stream end): learn templates and finalize buffered frames.
        If templates are incomplete and the stream continues, begin extended learning and keep collecting anchors from the end
        of the learning window (or from the current position if learning ended early), matching the offline extension range."""
        col, self._col = self._col, None
        if col is None:
            return
        self.keywords = build_keywords([col])
        self.detector.set_keywords(self.keywords)
        buf, self._buf, self._provisional = self._buf, None, None
        self._log(f"Keyword learning complete ({len(buf or [])} buffered frames)")
        for bt, br in buf or []:
            self.tracker.feed(bt, self.detector.resolve(br))
        if t is not None and not keywords_complete(self.keywords):
            self._head_col, self._head_kw = col, self.keywords
            self._late_col = AnchorCollector(self.profile, self.detector)
            # When the learning window ends early (buffer limit), continue collecting from the next frame; this frame was already fed to its collectors.
            self._late_from = self._learn_hi if t >= self._learn_hi - _EPS else t + STEP
            self._replay, self._replay_bytes = [], 0
            for bt, br in buf or []:
                self._record(bt, br)
            self._log("Too few kills at the start to learn all keyword templates; continuing extended learning")

    def _record(self, t: float, r: FrameResult | Pending) -> None:
        self._replay.append((t, r))
        self._replay_bytes += FRAME_RECORD_BYTES + (r.ink.nbytes if isinstance(r, Pending) else 0)

    def _late(self, t: float, banner: np.ndarray | None, r: FrameResult | Pending, f: IconFrame | None) -> None:
        """Process one frame during extended learning: record it, collect anchors, and try filling missing templates when another anchor banner is added."""
        self._record(t, r)
        if self._replay_bytes > self._late_max:
            self._log("Extended learning frame history reached its limit; stopping extended learning")
            self.degraded.append("late_learn_cap")
            self._settle_late()
            self._replay = self._late_col = None
            return
        if t >= self._late_from - _EPS and f is not None:
            self._late_col.feed_features(t, banner, f)
            groups = len(self._late_col.hand.groups) + len(self._late_col.knock.groups)
            if groups != self._late_groups:
                self._late_groups = groups
                self._settle_late()
            if self._late_col.full(t):  # Later anchors cannot change templates (only earliest anchors are used), so stop recording.
                self._settle_late()
                self._replay = self._late_col = None

    def _settle_late(self) -> None:
        """Fill missing templates from current anchors; if templates change, re-finalize from the frame log (future frames use the new templates directly)."""
        if self._late_col is None:
            return
        kw = extend_keywords(self._head_kw, build_keywords([self._head_col, self._late_col]))
        if same_keywords(kw, self.keywords):
            return
        self.keywords = kw
        self.detector.set_keywords(kw)
        self.tracker = EventTracker(self.profile)
        for bt, br in self._replay:
            self.tracker.feed(bt, self.detector.resolve(br))
        self._log(f"Extended learning added keyword templates; reclassifying {len(self._replay)} frames")

    def snapshot(self) -> tuple[list[Event], list[SpecInterval]]:
        """Current events (after derive) and spectating intervals; empty during calibration and provisional during keyword learning."""
        src = self._provisional if self._buf is not None else self.tracker
        if src is None:
            return [], []
        events, spec = src.snapshot()
        return derive(events, spec, self.profile), spec

    def finish(self) -> tuple[list[Event], list[SpecInterval]]:
        """End the stream: choose a scale from existing hits if not yet selected (as offline does when scanning ends with too few hits), and learn keywords from existing anchors if needed."""
        if self._calib is not None:
            self._calibrated()
        self._learned()
        self._settle_late()  # Choose final templates from all anchors (same as offline finalize).
        events, spec = self.tracker.finish()
        return derive(events, spec, self.profile), list(spec)


class LiveEngine:
    """Poll shared memory and pass each slot to kill detection (banner/spec) and match segmentation (thumb); emit resulting events."""

    def __init__(self, reader: ShmReader, profile: Profile, scene: SceneDetector | None,
                 emit: Callable[[dict], None], *, clock: Callable[[], float] = time.monotonic,
                 log: Callable[[str], None] | None = None, kills: LiveKills | None = None):
        self.reader = reader
        self.profile = profile
        # aditorrec writes capture rects (every aspect); older hosts write the 16:9 reference rects unchanged.
        self._restore = reader.layout.banner == tuple(profile.capture_banner[2:])
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
        # Send snapshots only when the event list changes; initially treat an empty list as sent (always send the final snapshot during shutdown).
        self._snap_doc = self._snapshot_doc([], [])[1]

    # ---- Reading ----
    def poll(self) -> int:
        """Process all currently readable slots; return the number of frames processed (0 means no new slots)."""
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
        """Convert PTS to time on the 0.25-second grid (EventTracker uses STEP to detect consecutive frames); return None for extra slots written faster than 4 fps."""
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
        banner, spec = self.profile.restore(slot.banner, slot.spec) if self._restore else (slot.banner, slot.spec)
        self.kills.feed(t, banner, spec)
        if slot.thumb is not None and self.scene is not None:  # No scene templates (Valorant): no match events.
            for ev in self.matches.feed(t, self.scene.classify(slot.thumb)):
                self.emit({"ev": ev.type, "t": ev.t, "reason": ev.reason})
        cpu = time.process_time() - cpu0
        self.last_t, self.last_pts = t, slot.pts
        self.frames += 1
        self.cpu_total += cpu
        self._win_frames += 1
        self._win_cpu += cpu
        return True

    # ---- Periodic output ----
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
        """Finish EventTracker and MatchTracker (at the last timestamp), then emit match events, stats, and the final snapshot."""
        final = self.kills.finish()
        for ev in self.matches.finish(self.last_t or 0.0):
            self.emit({"ev": ev.type, "t": ev.t, "reason": ev.reason})
        self._stats()
        self._snapshot(force=True, final=final, quality=self.quality())

    def quality(self) -> dict:
        """Whether the final result can be used directly as an analysis result (equivalent to offline): no buffer limit was hit and few slots were skipped or torn."""
        reasons = list(self.kills.degraded)
        lost = self.skipped + self.torn
        if self.frames and lost / (self.frames + lost) > MAX_LOSS_RATIO:
            reasons.append("frames_lost")
        return {"complete": not reasons, "reasons": reasons, "h_scale": self.kills.h_scale,
                "aspect_squash": self.profile.layout.squash,
                "frames": self.frames, "skipped": self.skipped, "torn": self.torn}


def _check_layout(layout: ShmLayout, profile, needs_thumb: bool = True) -> None:
    """Small-frame dimensions must match the profile capture rects (aditorrec crops using a 1920×1080 reference), or the
    reference ROIs when the game is 16:9; the thumbnail must be large enough for scene classification."""
    sizes = (layout.banner, layout.spec)
    capture = (tuple(profile.capture_banner[2:]), tuple(profile.capture_spec[2:]))
    rois = (getattr(profile, "banner_roi", None), getattr(profile, "spec_roi", None))
    reference = (tuple(rois[0][2:]), tuple(rois[1][2:])) if None not in rois else None
    if sizes != capture and not (sizes == reference and profile.layout.identity):
        raise LayoutError(f"banner/spec dimensions {layout.banner}/{layout.spec} do not match profile capture ROIs "
                          f"{capture[0]}/{capture[1]} for aspect squash {profile.layout.squash}")
    if needs_thumb and (layout.thumb[0] < SCENE_SIZE[0] or layout.thumb[1] < SCENE_SIZE[1]):
        raise LayoutError(f"thumb {layout.thumb} is smaller than required for scene detection ({SCENE_SIZE})")


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
    """On stdin EOF or a line containing {"cmd":"stop"}, set stop; ignore other lines (log them to stderr)."""
    try:
        for raw in stdin:
            line = raw.decode("utf-8", errors="replace").strip() if isinstance(raw, bytes) else raw.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except ValueError:
                _log(f"Ignoring unparseable command: {line[:200]}")
                continue
            if isinstance(req, dict) and req.get("cmd") == "stop":
                break
            _log(f"Ignoring unknown command: {line[:200]}")
    except (OSError, ValueError) as e:
        _log(f"Failed to read stdin; treating it as a stop request: {e}")
    finally:
        stop.set()


def run(shm: str, profile_dir: Path, scene_dir: Path | None = None, *, stdin=None, stdout=None,
        poll_interval: float = POLL_INTERVAL, aspect: str | None = None, game: str | None = None) -> int:
    out = _Out(stdout if stdout is not None else sys.stdout.buffer)
    stdin = stdin if stdin is not None else sys.stdin.buffer
    try:
        g = resolve_game(game)
        require_analyzable(g)
    except UnsupportedGame as e:
        out.send({"ev": "error", "code": "unsupported_game", "message": str(e)})
        return 1
    kills = None
    try:
        if g == "valorant":
            # Matches and rounds come from the Riot client later; the kill feed needs no scene templates.
            from .valorant import ValorantLiveKills, load_valorant_profile
            profile = load_valorant_profile(Path(profile_dir))
            scene, kills = None, ValorantLiveKills(profile)
        else:
            layout = parse_aspect(aspect) if aspect else Layout(1.0)
            profile = load_profile(Path(profile_dir)).with_layout(layout)
            scene = SceneDetector(Path(scene_dir) if scene_dir else None, layout=layout)
    except Exception as e:  # noqa: BLE001
        out.send({"ev": "error", "code": "internal", "message": f"Failed to load templates: {e}"})
        return 1
    try:
        reader = ShmReader.open(shm)
    except LayoutError as e:
        out.send({"ev": "error", "code": "bad_layout", "message": str(e)})
        return 1
    except OSError as e:
        out.send({"ev": "error", "code": "shm_open_failed", "message": f"Could not open shared memory {shm}: {e}"})
        return 1
    try:
        try:
            _check_layout(reader.layout, profile, needs_thumb=scene is not None)
        except LayoutError as e:
            out.send({"ev": "error", "code": "bad_layout", "message": str(e)})
            return 1
        lay = reader.layout
        out.send({"ev": "ready", "engine_version": ENGINE_VERSION, "banner": list(lay.banner),
                  "spec": list(lay.spec), "thumb": list(lay.thumb)})
        stop = threading.Event()
        threading.Thread(target=_watch_stdin, args=(stdin, stop), daemon=True).start()
        engine = LiveEngine(reader, profile, scene, out.send, log=_log, kills=kills)
        try:
            while not stop.is_set():
                if engine.poll() == 0:
                    stop.wait(poll_interval)
            engine.poll()  # Process slots written before shutdown.
            engine.finish()
        except Exception as e:  # noqa: BLE001
            out.send({"ev": "error", "code": "internal", "message": f"{type(e).__name__}: {e}"})
            return 1
        return 0
    finally:
        reader.close()
