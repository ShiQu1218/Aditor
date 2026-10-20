"""Live mode (python -m aditor live): shared-memory reader, torn frames, skipped slots, writer disappearance, stdin EOF, and consistency with offline analysis.

The test writer, ShmTestWriter, writes to a Windows named file mapping using the layout in recorder/src/shm.rs (mmap tagname).
Acceptance checks require external videos and are skipped when they are unavailable:
- Golden recording (ADITOR_GOLDEN_VIDEO): compare live's final counted events with offline analyze (recall difference <= 5%, no extra counted events).
- User recordings (ADITOR_MATCH_DIR): feed thumbnails to live and compare match start/end times with analyze_matches (±2 seconds)."""
from __future__ import annotations

import json
import mmap
import os
import struct
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import pytest

from conftest import ICON_DIR, REPO, make_video

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Shared memory reader supports Windows only")

from aditor.live import (LATEST_SEQ_OFFSET, MAX_LAG_SLOTS, PTS_PER_SECOND, SHM_HEADER_BYTES, SHM_MAGIC,  # noqa: E402
                         SHM_SLOTS, SHM_VERSION, LayoutError, LiveEngine, LiveKills, ShmLayout, ShmReader)
from aditor.profile import Profile  # noqa: E402

ENGINE_DIR = Path(__file__).resolve().parents[1]
GOLDEN = os.environ.get("ADITOR_GOLDEN_VIDEO")
MATCH_DIR = Path(os.environ.get("ADITOR_MATCH_DIR", "E:/Apex_highlighter_clip"))
# Match acceptance runs only the shortest clip and one long recording to limit runtime.
MATCH_VIDEOS = ["從上場不退出直接下一場~中途死掉，觀戰敵人同時排隊.mp4", "外卡模式.mp4"]
TICK = 0.25


def _name() -> str:
    return f"Local\\aditor-test-{uuid.uuid4().hex}"


class ShmTestWriter:
    """Test writer that follows the shm.rs layout: seq_end=0 → seq_begin → data → seq_end → latest_seq."""

    def __init__(self, name: str, layout: ShmLayout, *, magic: bytes = SHM_MAGIC, version: int = SHM_VERSION):
        self.layout = layout
        self.mm = mmap.mmap(-1, layout.total_size, tagname=name)
        self.mm[0:8] = magic
        struct.pack_into("<9I", self.mm, 8, version, SHM_SLOTS, layout.slot_size, *layout.banner,
                         *layout.spec, *layout.thumb)
        self.seq = 0

    def slot_offset(self, seq: int) -> int:
        return SHM_HEADER_BYTES + ((seq - 1) % SHM_SLOTS) * self.layout.slot_size

    def write(self, pts: int, banner: np.ndarray, spec: np.ndarray, thumb: np.ndarray | None = None) -> int:
        lay = self.layout
        seq = self.seq + 1
        off = self.slot_offset(seq)
        end = off + lay.slot_size - 8
        struct.pack_into("<Q", self.mm, end, 0)
        struct.pack_into("<Q", self.mm, off, seq)
        struct.pack_into("<qI", self.mm, off + 8, int(pts), 1 if thumb is not None else 0)
        a = off + 24
        self.mm[a:a + lay.banner_bytes] = np.ascontiguousarray(banner, np.uint8).tobytes()
        a += lay.banner_bytes
        self.mm[a:a + lay.spec_bytes] = np.ascontiguousarray(spec, np.uint8).tobytes()
        if thumb is not None:
            a += lay.spec_bytes
            self.mm[a:a + lay.thumb_bytes] = np.ascontiguousarray(thumb, np.uint8).tobytes()
        struct.pack_into("<Q", self.mm, end, seq)
        struct.pack_into("<Q", self.mm, LATEST_SEQ_OFFSET, seq)
        self.seq = seq
        return seq

    def set_seq_end(self, seq: int, value: int) -> None:
        struct.pack_into("<Q", self.mm, self.slot_offset(seq) + self.layout.slot_size - 8, value)

    def close(self) -> None:
        self.mm.close()


@pytest.fixture(scope="module")
def layout(profile):
    return ShmLayout(tuple(profile.banner_roi[2:]), tuple(profile.spec_roi[2:]), (640, 360))


@pytest.fixture(scope="module")
def scene():
    from aditor.scene import SceneDetector
    return SceneDetector()


def _blank(lay: ShmLayout, value: int = 0):
    banner = np.full((lay.banner[1], lay.banner[0], 3), value, np.uint8)
    spec = np.full((lay.spec[1], lay.spec[0], 3), value, np.uint8)
    thumb = np.full((lay.thumb[1], lay.thumb[0]), value, np.uint8)
    return banner, spec, thumb


def _pts(t: float) -> int:
    return int(round(t * PTS_PER_SECOND))


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


# ---------------- Layout and reader ----------------

def test_slot_size_matches_rust_layout():
    # Same layout as the shm.rs test: banner 7×3, spec 5×2, thumb 4×2 → 63+30+8+32 = 133 → align to 8 = 136.
    lay = ShmLayout((7, 3), (5, 2), (4, 2))
    assert lay.slot_size == 136
    assert lay.total_size == SHM_HEADER_BYTES + 16 * 136


def test_reader_copies_slots_and_thumb_flag():
    lay = ShmLayout((7, 3), (5, 2), (4, 2))
    name = _name()
    w = ShmTestWriter(name, lay)
    r = ShmReader.open(name)
    try:
        assert r.layout == lay and r.latest() == 0
        for seq in range(1, 6):
            b = np.full((3, 7, 3), seq, np.uint8)
            s = np.full((2, 5, 3), seq + 1, np.uint8)
            th = np.full((2, 4), seq + 2, np.uint8)
            w.write(seq * 2_500_000, b, s, th if seq % 4 == 0 else None)
        assert r.latest() == 5
        for seq in range(1, 6):
            slot = r.read(seq)
            assert slot.seq == seq and slot.pts == seq * 2_500_000
            assert (slot.banner == seq).all() and slot.banner.shape == (3, 7, 3)
            assert (slot.spec == seq + 1).all() and slot.spec.shape == (2, 5, 3)
            assert (slot.thumb is not None) == (seq % 4 == 0)
            if slot.thumb is not None:
                assert (slot.thumb == seq + 2).all() and slot.thumb.shape == (2, 4)
        assert r.peek_pts(5) == 12_500_000
    finally:
        r.close()
        w.close()


def test_torn_and_overwritten_slots_are_rejected():
    lay = ShmLayout((7, 3), (5, 2), (4, 2))
    name = _name()
    w = ShmTestWriter(name, lay)
    r = ShmReader.open(name)
    try:
        b, s = np.zeros((3, 7, 3), np.uint8), np.zeros((2, 5, 3), np.uint8)
        w.write(0, b, s)
        w.set_seq_end(1, 0)            # Write in progress (seq_end has not been updated).
        assert r.read(1) is None
        w.set_seq_end(1, 1)
        assert r.read(1) is not None
        for _ in range(SHM_SLOTS):     # seq 17 overwrites seq 1's slot.
            w.write(0, b, s)
        assert r.read(1) is None and r.read(17) is not None
        assert r.read(0) is None
    finally:
        r.close()
        w.close()


@pytest.mark.parametrize("mutate, message", [
    (lambda mm: mm.__setitem__(slice(0, 8), b"BADMAGIC"), "magic"),
    (lambda mm: struct.pack_into("<I", mm, 8, 2), "version"),
    (lambda mm: struct.pack_into("<I", mm, 12, 8), "Slot count"),
    (lambda mm: struct.pack_into("<I", mm, 16, 128), "Slot size"),
    (lambda mm: struct.pack_into("<I", mm, 20, 0), "greater than 0"),
])
def test_bad_header_rejected(mutate, message):
    lay = ShmLayout((7, 3), (5, 2), (4, 2))
    name = _name()
    w = ShmTestWriter(name, lay)
    try:
        mutate(w.mm)
        with pytest.raises(LayoutError, match=message):
            ShmReader.open(name)
    finally:
        w.close()


def test_open_missing_mapping_fails_without_creating_it():
    name = _name()
    with pytest.raises(OSError):
        ShmReader.open(name)
    with pytest.raises(OSError):  # The reader must not create the mapping, or aditorrec will refuse to create it later.
        ShmReader.open(name)


# ---------------- Engine polling: skipped slots, torn frames, and time grid ----------------

def _engine(name, lay, profile, scene, clock=None):
    out: list[dict] = []
    w = ShmTestWriter(name, lay)
    r = ShmReader.open(name)
    eng = LiveEngine(r, profile, scene, out.append, clock=clock or FakeClock())
    return w, r, eng, out


def test_engine_jumps_to_latest_when_lagging(profile, layout, scene):
    w, r, eng, out = _engine(_name(), layout, profile, scene)
    try:
        b, s, th = _blank(layout)
        w.write(0, b, s, th)
        assert eng.poll() == 1
        for k in range(1, 40):         # Writer produces 39 frames at once: 39 unread > 16.
            w.write(_pts(k * TICK), b, s, th if k % 4 == 0 else None)
        assert eng.poll() == 1         # Read only the latest frame.
        assert eng.skipped == 38 and eng.torn == 0 and eng.frames == 2
        assert eng.last_t == 39 * TICK
        for k in range(40, 40 + MAX_LAG_SLOTS):  # Exactly 16 unread frames: do not skip.
            w.write(_pts(k * TICK), b, s)
        assert eng.poll() == MAX_LAG_SLOTS and eng.skipped == 38
    finally:
        r.close()
        w.close()


def test_engine_counts_torn_slots_and_continues(profile, layout, scene):
    w, r, eng, out = _engine(_name(), layout, profile, scene)
    try:
        b, s, th = _blank(layout)
        for k in range(5):
            w.write(_pts(k * TICK), b, s)
        w.set_seq_end(3, 0)
        assert eng.poll() == 4
        assert eng.torn == 1 and eng.frames == 4
    finally:
        r.close()
        w.close()


def test_engine_starts_with_bounded_backlog(profile, layout, scene):
    w, r, eng, out = _engine(_name(), layout, profile, scene)
    try:
        b, s, _ = _blank(layout)
        for k in range(12):            # 12 frames were written before the reader began polling: catch up on only the latest 8.
            w.write(_pts(k * TICK), b, s)
        assert eng.poll() == 8 and eng.skipped == 0
        assert eng.last_t == 11 * TICK
    finally:
        r.close()
        w.close()


def test_engine_snaps_jittered_pts_to_quarter_second_grid(profile, layout, scene):
    w, r, eng, out = _engine(_name(), layout, profile, scene)
    try:
        b, s, _ = _blank(layout)
        ts = []
        for raw in (0.0, 0.26, 0.49, 0.74, 0.76, 1.01, 1.6):  # 0.76 and 0.74 fall in the same frame; 1.6 skips a frame.
            w.write(_pts(raw), b, s)
            eng.poll()
            ts.append(eng.last_t)
        assert ts == [0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5]
        w.write(_pts(1.52), b, s)      # Writer is slightly ahead: advance to the next frame (still within one-frame tolerance).
        assert eng.poll() == 1 and eng.last_t == 1.75
        w.write(_pts(1.54), b, s)      # Any faster would be more than one frame ahead; discard the extra frame.
        assert eng.poll() == 0 and eng.skipped == 1 and eng.last_t == 1.75
    finally:
        r.close()
        w.close()


def test_engine_emits_stats_and_final_snapshot(profile, layout, scene):
    clock = FakeClock()
    w, r, eng, out = _engine(_name(), layout, profile, scene, clock)
    try:
        b, s, th = _blank(layout)
        for k in range(30):
            w.write(_pts(k * TICK), b, s, th if k % 4 == 0 else None)
            clock.now += TICK
            eng.poll()
        eng.finish()
        stats = [o for o in out if o["ev"] == "stats"]
        assert stats and set(stats[0]) == {"ev", "t", "frames", "skipped", "torn", "lag_s", "cpu_ms_per_frame"}
        assert stats[-1]["frames"] == 30 and stats[-1]["cpu_ms_per_frame"] > 0
        assert out[-1]["ev"] == "snapshot" and out[-1]["events"] == [] and out[-1]["t"] == 29 * TICK
        assert out[-1]["final"] is True
        assert out[-1]["quality"]["complete"] is True and out[-1]["quality"]["reasons"] == []
    finally:
        r.close()
        w.close()


# ---------------- CLI: ready/EOF/stop, writer disappearance, and errors ----------------

def _spawn(name: str):
    env = dict(os.environ, PYTHONPATH=str(ENGINE_DIR))
    return subprocess.Popen([sys.executable, "-m", "aditor", "live", "--shm", name,
                             "--profile-dir", str(ICON_DIR), "--scene-dir", str(REPO / "templates" / "scene")],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)


class _Lines:
    """Read JSON lines from stdout in the background so subprocess output cannot block the test."""

    def __init__(self, proc):
        self.items: list[dict] = []
        self._cv = threading.Condition()
        self._t = threading.Thread(target=self._pump, args=(proc.stdout,), daemon=True)
        self._t.start()

    def _pump(self, pipe):
        for raw in pipe:
            with self._cv:
                self.items.append(json.loads(raw.decode("utf-8")))
                self._cv.notify_all()

    def wait_for(self, pred, timeout=30.0):
        end = time.monotonic() + timeout
        with self._cv:
            while not any(pred(o) for o in self.items):
                left = end - time.monotonic()
                assert left > 0, self.items
                self._cv.wait(left)

    def join(self):
        self._t.join(timeout=10)


@pytest.mark.parametrize("how", ["eof", "stop"])
def test_cli_stops_on_eof_or_stop_after_writer_disappears(layout, how):
    name = _name()
    w = ShmTestWriter(name, layout)
    proc = _spawn(name)
    lines = _Lines(proc)
    try:
        lines.wait_for(lambda o: o["ev"] == "ready")
        ready = lines.items[0]
        assert ready["banner"] == list(layout.banner) and ready["spec"] == list(layout.spec)
        assert ready["thumb"] == [640, 360] and ready["engine_version"]
        b, s, th = _blank(layout)
        n = 12
        for k in range(n):
            w.write(_pts(k * TICK), b, s, th if k % 4 == 0 else None)
            time.sleep(0.03)
        w.close()                      # If the writer disappears while the reader holds the mapping, it must not crash or busy-wait.
        time.sleep(0.5)
        assert proc.poll() is None
        if how == "stop":
            proc.stdin.write(b'{"cmd":"stop"}\n')
            proc.stdin.flush()
        else:
            proc.stdin.close()
        assert proc.wait(timeout=60) == 0, proc.stderr.read().decode("utf-8", errors="replace")
        lines.join()
        assert lines.items[-1]["ev"] == "snapshot"
        final_stats = [o for o in lines.items if o["ev"] == "stats"][-1]
        assert final_stats["frames"] == n and final_stats["skipped"] == 0 and final_stats["torn"] == 0
    finally:
        if proc.poll() is None:
            proc.kill()
        w.close()


def test_cli_eof_before_any_frame(layout):
    name = _name()
    w = ShmTestWriter(name, layout)
    proc = _spawn(name)
    try:
        out, err = proc.communicate(timeout=60)
        assert proc.returncode == 0, err.decode("utf-8", errors="replace")
        evs = [json.loads(x) for x in out.decode("utf-8").splitlines()]
        assert [e["ev"] for e in evs] == ["ready", "stats", "snapshot"]
        assert {k: evs[-1][k] for k in ("ev", "t", "events", "spectating", "final")} ==             {"ev": "snapshot", "t": 0.0, "events": [], "spectating": [], "final": True}
    finally:
        w.close()


def test_cli_errors(layout):
    proc = _spawn(_name())             # Mapping does not exist.
    out, _ = proc.communicate(timeout=60)
    assert proc.returncode == 1
    err = json.loads(out.decode("utf-8").splitlines()[-1])
    assert err["ev"] == "error" and err["code"] == "shm_open_failed"

    name = _name()                     # Small image dimensions do not match the configured ROI.
    w = ShmTestWriter(name, ShmLayout((7, 3), (5, 2), (640, 360)))
    try:
        proc = _spawn(name)
        out, _ = proc.communicate(timeout=60)
        assert proc.returncode == 1
        assert json.loads(out.decode("utf-8").splitlines()[-1])["code"] == "bad_layout"
    finally:
        w.close()


# ---------------- Consistency with offline analysis ----------------

def _with_thumbs(frames, thumbs):
    """Attach one thumbnail every four frames (1 fps, like aditorrec) to the (t, banner, spec) stream; omit thumbnails after they run out."""
    for k, (t, banner, spec) in enumerate(frames):
        yield t, banner, spec, (next(thumbs, None) if k % 4 == 0 else None)


def _run_live(layout, profile, scene, frames):
    """Alternate writing a slot and polling in one process without skipped slots; return (output events, engine). frames: (t, banner, spec, thumb|None)."""
    clock = FakeClock()
    w, r, eng, out = _engine(_name(), layout, profile, scene, clock)
    try:
        for t, banner, spec, th in frames:
            w.write(_pts(t), banner, spec, th)
            clock.now += TICK
            assert eng.poll() == 1
        eng.finish()
    finally:
        r.close()
        w.close()
    assert eng.skipped == 0 and eng.torn == 0
    return out, eng


def test_live_emits_hud_resume_from_sustained_hud(profile, layout, scene):
    from test_scene import load_screen

    lobby = load_screen({"file": "clip1_0000.png"})
    hud = load_screen({"file": "clip1_0120.png"})
    banner, spec, black = _blank(layout)

    def frames():
        for t in range(9):
            thumb = lobby if t == 0 else black if t < 4 else hud
            for j in range(4):
                yield t + j * TICK, banner, spec, thumb if j == 0 else None

    out, eng = _run_live(layout, profile, scene, frames())
    assert [o for o in out if o["ev"] in ("match_start", "match_end")] == [
        {"ev": "match_start", "t": 4.0, "reason": "hud_resume"},
        {"ev": "match_end", "t": 8.75, "reason": "eof"}]


def _counted(events):
    return [(e["type"], e["t"]) for e in events if e["counted"]]


def _compare(offline, live):
    """Return (recall, live counted events absent offline); events match when their types agree and times differ by at most 0.5 seconds."""
    left = list(live)
    hit = 0
    for typ, t in offline:
        m = next((x for x in left if x[0] == typ and abs(x[1] - t) <= 0.5), None)
        if m is not None:
            left.remove(m)
            hit += 1
    return (hit / len(offline) if offline else 1.0), left


def test_live_matches_offline_on_synthetic_video(tmp_path, profile, layout, scene, knock_banner_png):
    from aditor.analyze import analyze
    from aditor.decode import FrameStream
    video = make_video(tmp_path, "kills.mp4", 24, overlay=(knock_banner_png, [(2, 5), (9, 12), (17, 19)]))
    doc = analyze(str(video), profile, cache_dir=tmp_path / "cache", jobs=1)
    out, eng = _run_live(layout, profile, scene, ((t, b, s, None) for t, b, s in FrameStream(str(video), profile)))
    final = out[-1]
    assert final["ev"] == "snapshot"
    assert eng.kills.h_scale == doc["analysis"]["h_scale"]
    assert [(e["type"], e["t"], e["counted"]) for e in final["events"]] == \
        [(e["type"], e["t"], e["counted"]) for e in doc["events"]]
    assert final["spectating"] == doc["spectating"]
    assert len(doc["events"]) >= 3
    assert final["quality"]["complete"] is True and final["quality"]["h_scale"] == doc["analysis"]["h_scale"]


def test_live_kills_small_buffers_degrade_gracefully(tmp_path, profile, knock_banner_png):
    """With a very small buffer limit, determine scale and learn keywords early while still producing events without crashing."""
    from aditor.decode import FrameStream
    video = make_video(tmp_path, "kills.mp4", 12, overlay=(knock_banner_png, [(2, 5), (8, 10)]))
    logs: list[str] = []
    kills = LiveKills(profile, calib_max_bytes=1, pending_max_bytes=1, log=logs.append)
    for t, banner, spec in FrameStream(str(video), profile):
        kills.feed(t, banner, spec)
    events, _ = kills.finish()
    assert kills.phase == "detecting" and kills.h_scale is not None
    assert any("early" in m for m in logs)
    assert len(events) >= 2
    assert {"calib_buffer_cap", "pending_buffer_cap"} & set(kills.degraded)


def test_quality_flags_lost_frames(profile, layout, scene):
    clock = FakeClock()
    w, r, eng, out = _engine(_name(), layout, profile, scene, clock)
    try:
        eng.frames, eng.skipped = 100, 5
        q = eng.quality()
        assert q["complete"] is False and "frames_lost" in q["reasons"]
        eng.skipped = 0
        assert eng.quality()["complete"] is True
    finally:
        r.close()
        w.close()


@pytest.mark.timeout(900)
def test_golden_live_vs_offline(tmp_path, profile, layout, scene):
    if not GOLDEN or not Path(GOLDEN).exists():
        pytest.skip("ADITOR_GOLDEN_VIDEO is not set")
    from aditor.analyze import analyze
    from aditor.decode import FrameStream
    from aditor.matches import _video_frames
    from aditor.probe import probe
    info = probe(GOLDEN)
    doc = analyze(GOLDEN, profile, cache_dir=tmp_path, jobs=1)
    thumbs = (f for _, f in _video_frames(GOLDEN, 1.0, True, info.codec))
    frames = _with_thumbs(FrameStream(GOLDEN, profile, codec=info.codec), thumbs)
    out, eng = _run_live(layout, profile, scene, frames)
    final = out[-1]
    offline, live = _counted(doc["events"]), _counted(final["events"])
    recall, extra = _compare(offline, live)
    cpu = 1000.0 * eng.cpu_total / eng.frames
    identical = ([(e["type"], e["t"], e["counted"]) for e in final["events"]]
                 == [(e["type"], e["t"], e["counted"]) for e in doc["events"]])
    print(f"\nGolden recording: {len(offline)} offline and {len(live)} live counted events, recall {recall:.3f}, {extra} extra; "
          f"{len(doc['events'])}/{len(final['events'])} total events, identical: {identical}; "
          f"h_scale offline {doc['analysis']['h_scale']}, live {eng.kills.h_scale}; "
          f"{eng.frames} frames, CPU {cpu:.2f} ms/frame")
    assert recall >= 0.95
    assert extra == []
    assert [o for o in out if o["ev"] == "snapshot"]


@pytest.mark.timeout(1800)
@pytest.mark.parametrize("name", MATCH_VIDEOS)
def test_recording_matches_live_vs_offline(profile, layout, scene, name):
    video = MATCH_DIR / name
    if not video.is_file():
        pytest.skip(f"No match acceptance video provided: {video}")
    from aditor.matches import _video_frames, analyze_matches
    from aditor.probe import probe
    info = probe(str(video))
    offline = analyze_matches(str(video))["matches"]
    banner, spec, _ = _blank(layout)

    def frames():
        for i, (t, thumb) in enumerate(_video_frames(str(video), 1.0, True, info.codec)):
            if t >= info.duration:
                break
            for j in range(4):
                yield (4 * i + j) * TICK, banner, spec, (thumb if j == 0 else None)

    out, eng = _run_live(layout, profile, scene, frames())
    starts = [o for o in out if o["ev"] == "match_start"]
    ends = [o for o in out if o["ev"] == "match_end"]
    print(f"\n{name}: offline {offline}; live start {starts} end {ends}")
    assert len(starts) == len(ends) == len(offline)
    for s, e, m in zip(starts, ends, offline):
        assert abs(s["t"] - m["start"]) <= 2
        assert abs(e["t"] - m["end"]) <= 2


@pytest.mark.parametrize("kind,t,reason", [("lobby", 1, "lobby"), ("other", 181, "timeout"), ("pre_match", 1, "eof")])
def test_live_forwards_pending_and_cancel(profile, layout, scene, monkeypatch, kind, t, reason):
    from aditor.scene import SceneFrame

    scenes = iter([SceneFrame("pre_match"), SceneFrame(kind)])
    monkeypatch.setattr(scene, "classify", lambda _: next(scenes))
    banner, spec, thumb = _blank(layout)
    out, _ = _run_live(layout, profile, scene, [(0, banner, spec, thumb), (t, banner, spec, thumb)])
    assert [o for o in out if o["ev"].startswith("match_")] == [
        {"ev": "match_pending", "t": 0, "reason": "pre_match"},
        {"ev": "match_cancel", "t": t, "reason": reason}]


# ---------------- Game aspect ratio ----------------

class _RawCaptureProfile(Profile):
    """Yield the capture crops aditorrec writes (capture_banner/capture_spec) instead of restored reference images."""

    def restore(self, banner_capture, spec_capture):
        return banner_capture, spec_capture


def test_layout_check_accepts_capture_rects_and_reference_rects_only_at_16_9(profile):
    from dataclasses import asdict
    from aditor.layout import parse_aspect
    from aditor.live import _check_layout
    capture = ShmLayout(tuple(profile.capture_banner[2:]), tuple(profile.capture_spec[2:]), (640, 360))
    reference = ShmLayout(tuple(profile.banner_roi[2:]), tuple(profile.spec_roi[2:]), (640, 360))
    four = profile.with_layout(parse_aspect("4:3"))
    _check_layout(capture, profile)
    _check_layout(capture, four)
    _check_layout(reference, profile)
    with pytest.raises(LayoutError):
        _check_layout(reference, four)
    assert asdict(four)["layout"]["squash"] == 0.75


def test_live_restores_stretched_4_3_capture_like_offline(tmp_path, profile, scene, knock_banner_png):
    from dataclasses import fields
    from aditor.analyze import analyze
    from aditor.decode import FrameStream
    from aditor.layout import parse_aspect
    four = profile.with_layout(parse_aspect("4:3"))
    video = make_video(tmp_path, "4比3.mp4", 16, overlay=(knock_banner_png, [(2, 5), (9, 12)]), game_height=1440)
    doc = analyze(str(video), four, cache_dir=tmp_path / "cache", jobs=1)
    raw = _RawCaptureProfile(**{f.name: getattr(four, f.name) for f in fields(Profile)})
    capture = ShmLayout(tuple(profile.capture_banner[2:]), tuple(profile.capture_spec[2:]), (640, 360))
    out, eng = _run_live(capture, four, scene, ((t, b, s, None) for t, b, s in FrameStream(str(video), raw)))
    final = out[-1]
    assert len(doc["events"]) >= 2
    assert [(e["type"], e["t"], e["counted"]) for e in final["events"]] == \
        [(e["type"], e["t"], e["counted"]) for e in doc["events"]]
    assert final["quality"]["aspect_squash"] == 0.75
