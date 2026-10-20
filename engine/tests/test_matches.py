import json
import io
import os
import subprocess
import sys
from pathlib import Path

import pytest

from aditor.matches import Match, MatchTracker, _video_frames, analyze_matches
from aditor.scene import SceneFrame

FIXTURES = Path(__file__).parent / "fixtures" / "matches"
TRUTH = json.loads((FIXTURES / "truth.json").read_text(encoding="utf-8"))


def run(parts, end=None, **kw):
    tracker = MatchTracker(**kw)
    for first, last, kind in parts:
        scene = SceneFrame("other", blank=True) if kind == "blank" else SceneFrame(kind)
        for t in range(first, last + 1):
            tracker.feed(t, scene)
    tracker.finish(end if end is not None else parts[-1][1] + 1)
    return tracker


def test_start_is_deferred_until_hud_and_backdated():
    tr = MatchTracker()
    assert [(e.type, e.t, e.reason) for e in tr.feed(0, SceneFrame("pre_match"))] == [("match_pending", 0, "pre_match")]
    assert tr.feed(1, SceneFrame("pre_match")) == []
    events = tr.feed(60, SceneFrame("in_match_hud"))
    assert [(e.type, e.t, e.reason) for e in events] == [("match_start", 0, "opening_confirmed")]
    assert tr.finish(100)[0].t == 100
    assert tr.matches == [Match(0, 100)]


def test_direct_next_match_closes_previous_at_first_opening():
    tr = run([(0, 20, "pre_match"), (21, 60, "in_match_hud"), (61, 75, "other"),
              (76, 90, "pre_match"), (91, 120, "in_match_hud")])
    assert tr.matches == [Match(0, 76), Match(76, 121)]
    assert [(e.type, e.t) for e in tr.events] == [
        ("match_pending", 0), ("match_start", 0), ("match_end", 76),
        ("match_pending", 76), ("match_start", 76), ("match_end", 121)]


def test_opening_flicker_does_not_split_one_sequence():
    tr = run([(0, 5, "pre_match"), (6, 7, "other"), (8, 15, "pre_match"),
              (16, 50, "in_match_hud")])
    assert tr.matches == [Match(0, 51)]


def test_brief_lobby_before_reward_menus_ends_after_settle_and_backdates():
    tr = MatchTracker()
    tr.feed(0, SceneFrame("in_match_hud"))
    for t in range(10, 13):
        assert not tr.feed(t, SceneFrame("lobby"))
    for t in range(13, 40):
        assert not tr.feed(t, SceneFrame("other"))  # Open a pack/reward screen.
    events = tr.feed(40, SceneFrame("other"))
    assert [(e.type, e.t, e.reason) for e in events] == [("match_end", 10, "lobby")]
    tr.finish(60)
    assert tr.matches == [Match(0, 10)]


def test_single_lobby_frame_is_not_enough():
    tr = run([(0, 9, "in_match_hud"), (10, 10, "lobby"), (11, 60, "other")])
    assert tr.matches == [Match(0, 61)]


def test_hud_after_brief_lobby_cancels_tentative_end():
    tr = run([(0, 9, "in_match_hud"), (10, 12, "lobby"), (13, 20, "in_match_hud"),
              (21, 80, "other")])
    assert tr.matches == [Match(0, 81)]
    assert [(e.type, e.t, e.reason) for e in tr.events] == [
        ("match_start", 0, "initial_match"), ("match_end", 81, "eof")]


def test_lobby_then_next_opening_ends_at_lobby():
    tr = run([(0, 9, "in_match_hud"), (10, 12, "lobby"), (13, 20, "other"),
              (21, 25, "pre_match"), (26, 30, "in_match_hud")])
    assert tr.matches == [Match(0, 10), Match(21, 31)]


def test_tentative_lobby_end_settles_at_eof():
    tr = run([(0, 9, "in_match_hud"), (10, 12, "lobby"), (13, 20, "other")])
    assert tr.matches == [Match(0, 10)]


def test_lobby_dropout_resets_continuity():
    tr = run([(0, 2, "in_match_hud"), (3, 3, "lobby"), (4, 4, "other"),
              (5, 32, "lobby")])
    assert tr.matches == [Match(0, 5)]


def test_missing_frames_cannot_confirm_continuous_lobby():
    tr = MatchTracker()
    for t, kind in [(0, "in_match_hud"), (1, "lobby"), (30, "lobby")]:
        tr.feed(t, SceneFrame(kind))
    tr.finish(31)
    assert tr.matches == [Match(0, 31)]


@pytest.mark.parametrize("hud_time,expected", [(180, [Match(0, 182)]), (181, [])])
def test_cancel_if_hud_does_not_appear_within_180_seconds(hud_time, expected):
    tr = run([(0, 20, "pre_match"), (21, hud_time - 1, "other"),
              (hud_time, 181, "in_match_hud")], end=182)
    assert tr.matches == expected


def test_cancelled_pairing_and_retry():
    tr = run([(0, 2, "pre_match"), (3, 4, "lobby"), (5, 8, "pre_match"),
              (9, 15, "in_match_hud")])
    assert tr.matches == [Match(5, 16)]


def test_unconfirmed_opening_at_eof_is_discarded():
    tr = run([(0, 10, "pre_match"), (11, 30, "other")])
    assert tr.matches == []
    assert [(e.type, e.t, e.reason) for e in tr.events] == [("match_pending", 0, "pre_match"), ("match_cancel", 31, "eof")]


def test_next_opening_can_cancel_without_reviving_previous():
    tr = run([(0, 10, "in_match_hud"), (11, 30, "other"), (31, 40, "pre_match"),
              (41, 220, "other")])
    assert tr.matches == [Match(0, 31)]


def test_respawn_spectating_queue_map_and_inventory_do_not_end_match():
    tr = run([(0, 10, "in_match_hud"), (11, 250, "other"), (251, 270, "in_match_hud")])
    assert tr.matches == [Match(0, 271)]


def test_recording_starts_in_match_with_menu_covering_hud():
    tr = run([(0, 9, "other"), (10, 20, "in_match_hud")])
    assert tr.matches == [Match(0, 21)]
    assert tr.events[0].reason == "initial_match"


@pytest.mark.parametrize("first", [0, 120])
@pytest.mark.parametrize("delay", [1, 10])
@pytest.mark.parametrize("summary", [False, True])
def test_initial_recovery_within_window_uses_first_sample(first, delay, summary):
    tr = MatchTracker()
    tr.feed(first, SceneFrame("other"))
    scene = SceneFrame("other", match_context=True) if summary else SceneFrame("in_match_hud")
    events = tr.feed(first + delay, scene)
    reason = "initial_summary" if summary else "initial_match"
    assert [(e.type, e.t, e.reason) for e in events] == [("match_start", first, reason)]


@pytest.mark.parametrize("delay", [11, 169, 449])
@pytest.mark.parametrize("summary", [False, True])
def test_initial_recovery_expires_and_only_sustained_hud_resumes(delay, summary):
    tr = MatchTracker()
    for t in range(delay):
        assert tr.feed(t, SceneFrame("other")) == []
    if summary:
        assert tr.feed(delay, SceneFrame("other", match_context=True)) == []
    first_hud = delay + int(summary)
    for t in range(first_hud, first_hud + 3):
        assert tr.feed(t, SceneFrame("in_match_hud")) == []
    events = tr.feed(first_hud + 3, SceneFrame("in_match_hud"))
    assert [(e.type, e.t, e.reason) for e in events] == [("match_start", first_hud, "hud_resume")]
    tr.finish(first_hud + 4)
    assert tr.matches == [Match(first_hud, first_hud + 4)]


def test_recording_starts_in_previous_summary():
    tr = MatchTracker()
    tr.feed(0, SceneFrame("other"))
    tr.feed(6, SceneFrame("other", match_context=True))
    tr.feed(11, SceneFrame("pre_match"))
    tr.feed(60, SceneFrame("in_match_hud"))
    tr.finish(100)
    assert tr.matches == [Match(0, 11), Match(11, 100)]


def test_other_alone_is_not_positive_match_evidence():
    tr = run([(0, 100, "other")])
    assert tr.matches == []


@pytest.mark.parametrize("unknown", [False, True])
def test_lobby_then_sustained_hud_resumes_at_first_hud(unknown):
    tr = MatchTracker()
    tr.feed(0, SceneFrame("lobby"))
    if unknown:
        for t in range(1, 10):
            tr.feed(t, SceneFrame("other"))
    for t in range(10, 13):
        assert tr.feed(t, SceneFrame("in_match_hud")) == []
    events = tr.feed(13, SceneFrame("in_match_hud"))
    assert [(e.type, e.t, e.reason) for e in events] == [("match_start", 10, "hud_resume")]
    assert tr.feed(14, SceneFrame("in_match_hud")) == []
    tr.finish(15)
    assert tr.matches == [Match(10, 15)]


def test_brief_hud_then_unknown_does_not_start_match():
    tr = run([(0, 20, "lobby"), (21, 23, "in_match_hud"), (24, 30, "other")])
    assert tr.matches == [] and tr.events == []


def test_unknown_sample_resets_hud_resume_run():
    tr = MatchTracker()
    tr.feed(0, SceneFrame("lobby"))
    for t, kind in [(1, "in_match_hud"), (2, "in_match_hud"), (3, "in_match_hud"),
                    (4, "other"), (5, "in_match_hud"), (6, "in_match_hud"), (7, "in_match_hud")]:
        assert tr.feed(t, SceneFrame(kind)) == []
    events = tr.feed(8, SceneFrame("in_match_hud"))
    assert [(e.type, e.t, e.reason) for e in events] == [("match_start", 5, "hud_resume")]


def test_sustained_hud_after_settled_lobby_starts_second_match():
    tr = run([(0, 9, "in_match_hud"), (10, 11, "lobby"), (12, 40, "other"),
              (41, 50, "in_match_hud")])
    assert tr.matches == [Match(0, 10), Match(41, 51)]
    assert [(e.type, e.t, e.reason) for e in tr.events] == [
        ("match_start", 0, "initial_match"), ("match_end", 10, "lobby"),
        ("match_start", 41, "hud_resume"), ("match_end", 51, "eof")]


@pytest.mark.parametrize("sample_period", [0.5, 1.0, 2.0])
def test_sample_gap_breaks_hud_resume_run(sample_period):
    tr = MatchTracker(sample_period=sample_period)
    tr.feed(0, SceneFrame("lobby"))
    tr.feed(sample_period, SceneFrame("in_match_hud"))
    tr.feed(2 * sample_period, SceneFrame("in_match_hud"))
    first = 2 * sample_period + 2.5 * sample_period + 0.25
    for offset in range(3):
        assert tr.feed(first + offset, SceneFrame("in_match_hud")) == []
    events = tr.feed(first + 3, SceneFrame("in_match_hud"))
    assert [(e.type, e.t, e.reason) for e in events] == [("match_start", first, "hud_resume")]


def test_hud_resume_uses_elapsed_seconds_and_allows_maximum_sample_gap():
    tr = MatchTracker(sample_period=0.5)
    tr.feed(0, SceneFrame("lobby"))
    for t in [0.5, 1.75, 2.0, 2.5, 3.0]:
        assert tr.feed(t, SceneFrame("in_match_hud")) == []
    events = tr.feed(3.5, SceneFrame("in_match_hud"))
    assert [(e.type, e.t, e.reason) for e in events] == [("match_start", 0.5, "hud_resume")]


def test_expired_opening_can_resume_from_hud():
    tr = MatchTracker()
    tr.feed(0, SceneFrame("pre_match"))
    assert [(e.type, e.t, e.reason) for e in tr.feed(181, SceneFrame("in_match_hud"))] == [("match_cancel", 181, "timeout")]
    for t in range(182, 184):
        assert tr.feed(t, SceneFrame("in_match_hud")) == []
    events = tr.feed(184, SceneFrame("in_match_hud"))
    assert [(e.type, e.t, e.reason) for e in events] == [("match_start", 181, "hud_resume")]


def test_game_hidden_between_matches_splits_at_hide():
    # DDA: after a match, switch away to queue for the next one and return only when skydiving; the screen is black in between.
    tr = run([(0, 100, "in_match_hud"), (101, 250, "blank"), (251, 300, "in_match_hud")])
    assert tr.matches == [Match(0, 101), Match(251, 301)]
    assert [(e.type, e.t, e.reason) for e in tr.events] == [
        ("match_start", 0, "initial_match"), ("match_end", 101, "hidden"),
        ("match_start", 251, "hud_resume"), ("match_end", 301, "eof")]


def test_brief_alt_tab_does_not_split_match():
    tr = run([(0, 100, "in_match_hud"), (101, 159, "blank"), (160, 200, "in_match_hud")])
    assert tr.matches == [Match(0, 201)]


def test_hidden_end_is_emitted_once_threshold_is_reached():
    tr = MatchTracker()
    tr.feed(0, SceneFrame("in_match_hud"))
    for t in range(10, 70):
        assert tr.feed(t, SceneFrame("other", blank=True)) == []
    events = tr.feed(70, SceneFrame("other", blank=True))
    assert [(e.type, e.t, e.reason) for e in events] == [("match_end", 10, "hidden")]


def test_lobby_before_hiding_keeps_lobby_end():
    tr = run([(0, 9, "in_match_hud"), (10, 11, "lobby"), (12, 100, "blank"), (101, 110, "in_match_hud")])
    assert tr.matches == [Match(0, 10), Match(101, 111)]


def test_recording_starts_hidden_then_hud_resumes_at_hud():
    tr = run([(0, 80, "blank"), (81, 90, "in_match_hud")])
    assert tr.matches == [Match(81, 91)]


def test_lobby_reset_allows_following_match():
    tr = run([(0, 1, "in_match_hud"), (2, 20, "lobby"), (21, 30, "pre_match"),
              (31, 50, "in_match_hud")])
    assert tr.matches == [Match(0, 2), Match(21, 51)]


def test_finish_is_idempotent_and_no_feed_after_finish():
    tr = run([(0, 5, "in_match_hud")])
    assert tr.finish(6) == []
    with pytest.raises(ValueError, match="has ended"):
        tr.feed(7, SceneFrame("other"))


@pytest.mark.parametrize("t", [-1, float("nan"), float("inf"), 0])
def test_invalid_frame_times(t):
    tr = MatchTracker()
    tr.feed(0, SceneFrame("other"))
    with pytest.raises(ValueError):
        tr.feed(t, SceneFrame("other"))


@pytest.mark.parametrize("fps", [0, -1, float("nan"), float("inf")])
def test_invalid_fps_rejected_before_probe(fps):
    with pytest.raises(ValueError, match="fps"):
        analyze_matches("not-a-video", fps=fps)


def test_no_video_cli_error_has_no_partial_json(tmp_path):
    result = subprocess.run([sys.executable, "-m", "aditor", "matches", str(tmp_path / "missing.mp4")],
                            capture_output=True)
    assert result.returncode == 1 and result.stdout == b""
    assert "Error" in result.stderr.decode("utf-8")


def test_cli_passes_options_and_outputs_json(monkeypatch, capsys):
    from aditor import __main__, matches
    from aditor.layout import Layout

    def fake(path, **kw):
        assert path == "clip.mp4"
        assert kw == {"fps": 2, "timeline": True, "hwaccel": False, "layout": Layout(0.75)}
        return {"matches": [{"start": 1, "end": 3}], "timeline": [[1, "pre_match"]]}

    monkeypatch.setattr(matches, "analyze_matches", fake)
    # pytest's StringIO has no reconfigure; preserve main's existing handling.
    for stream in (sys.stdout, sys.stderr):
        monkeypatch.setattr(stream, "reconfigure", lambda **kw: None, raising=False)
    assert __main__.main(["matches", "clip.mp4", "--fps", "2", "--timeline", "--no-hwaccel", "--aspect", "4:3"]) == 0
    assert json.loads(capsys.readouterr().out)["matches"] == [{"start": 1, "end": 3}]


def _fake_decoder(monkeypatch, outputs):
    from aditor import matches

    calls, procs = [], []

    class FakeProcess:
        def __init__(self, cmd, **kw):
            calls.append(cmd)
            data, self.rc = outputs[len(calls) - 1]
            self.stdout = io.BytesIO(data)
            self.killed = False
            procs.append(self)

        def wait(self, **kw):
            return self.rc

        def poll(self):
            return None if not self.stdout.closed and not self.killed else self.rc

        def kill(self):
            self.killed = True

    monkeypatch.setattr(matches.subprocess, "Popen", FakeProcess)
    monkeypatch.setattr(matches.ffbin, "ffmpeg", lambda: "ffmpeg")
    return calls, procs


def test_hardware_startup_fallback_and_ten_bit_format(monkeypatch):
    frame = bytes([20]) * (640 * 360)
    calls, procs = _fake_decoder(monkeypatch, [(b"", 1), (b"", 1), (frame, 0)])
    got = list(_video_frames("clip.mp4", 1, True, "av1"))
    assert len(got) == 1 and got[0][0] == 0 and got[0][1].mean() == 20
    assert "format=nv12" in calls[0][calls[0].index("-vf") + 1]
    assert "format=p010le" in calls[1][calls[1].index("-vf") + 1]
    assert "-hwaccel" not in calls[2]
    assert all(p.stdout.closed for p in procs)


def test_midstream_hardware_failure_resumes_without_duplicate_times(monkeypatch):
    size = 640 * 360
    calls, _ = _fake_decoder(monkeypatch, [(bytes([20]) * size, 1), (bytes([40]) * size, 0)])
    got = list(_video_frames("clip.mp4", 2, True, "av1"))
    assert [(t, frame.mean()) for t, frame in got] == [(0, 20), (0.5, 40)]
    assert len(calls) == 2 and "-hwaccel" not in calls[1]
    assert calls[1][calls[1].index("-ss") + 1] == "0.500"


def test_early_generator_close_terminates_decoder(monkeypatch):
    _, procs = _fake_decoder(monkeypatch, [(bytes(640 * 360 * 2), 0)])
    stream = _video_frames("clip.mp4", 1, False, "av1")
    next(stream)
    stream.close()
    assert procs[0].killed and procs[0].stdout.closed


@pytest.mark.parametrize("data,rc", [(b"bad", 0), (b"", 1)])
def test_decoder_failures_are_not_successful_partial_results(monkeypatch, data, rc):
    from aditor.decode import DecodeError

    _fake_decoder(monkeypatch, [(data, rc)])
    with pytest.raises(DecodeError):
        list(_video_frames("bad.mp4", 1, False, "av1"))


@pytest.mark.parametrize("offset,vfr", [(0, False), (5, False), (0, True)])
def test_real_scene_decoder_time_grid(tmp_path, offset, vfr):
    from aditor import ffbin

    video = tmp_path / "場景.mkv"
    filters = "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,1)'"
    if vfr:
        filters += ",select='not(eq(mod(n,7),3))',setpts='PTS+(0.006*sin(N*7))/TB'"
    cmd = [ffbin.ffmpeg(), "-v", "error", "-nostdin", "-f", "lavfi", "-i",
           "color=c=black:s=640x360:r=60:d=2", "-vf", filters, "-c:v", "ffv1"]
    if offset:
        cmd += ["-output_ts_offset", str(offset)]
    if vfr:
        cmd += ["-fps_mode", "passthrough"]
    result = subprocess.run([*cmd, str(video)], capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    frames = list(_video_frames(str(video), 2, False, "ffv1"))
    assert [t for t, _ in frames] == [0, 0.5, 1, 1.5]
    assert [t for t, frame in frames if frame.mean() > 220][0] == 1


@pytest.mark.timeout(300)
@pytest.mark.parametrize("name", list(TRUTH))
def test_recording_acceptance(name):
    root = Path(os.environ.get("ADITOR_MATCH_DIR", "E:/Apex_highlighter_clip"))
    video = root / name
    if not video.is_file():
        pytest.skip(f"No match acceptance video provided: {video}")
    # Use the real CLI, ffbin, and streaming state machine; decode instead of substituting cached scenes.
    result = subprocess.run([sys.executable, "-m", "aditor", "matches", str(video), "--timeline"],
                            capture_output=True, timeout=280)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    got = json.loads(result.stdout)
    expected = TRUTH[name]["matches"]
    assert len(got["matches"]) == len(expected)
    assert got["timeline"] and got["timeline"][0][0] == 0
    for actual, wanted in zip(got["matches"], expected):
        assert abs(actual["start"] - wanted["start"]) <= 5
        assert abs(actual["end"] - wanted["end"]) <= 5


@pytest.mark.parametrize("kind,t,reason", [("lobby", 2, "lobby"), ("other", 181, "timeout")])
def test_pending_cancellation_is_stream_only(kind, t, reason):
    tr = MatchTracker()
    tr.feed(0, SceneFrame("pre_match"))
    assert [(e.type, e.t, e.reason) for e in tr.feed(t, SceneFrame(kind))] == [("match_cancel", t, reason)]
    assert tr.finish(t + 1) == []
    assert tr.matches == []
