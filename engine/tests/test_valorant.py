from pathlib import Path

import cv2
import numpy as np
import pytest

from aditor.live import LiveEngine, ShmLayout, ShmReader, run as run_live
from aditor.valorant import (ValorantLiveKills, ALLY_STRIP, ENEMY_STRIP, SCORE_BOX, ROW_H, ROW_STEP, ROW_Y0, RIGHT_EDGE, FeedDetector,
                             BANNER_REF, FeedRow, FeedTracker, ValorantProfileError, load_valorant_profile,
                             scoreboard_visible)

TEMPLATES = Path(__file__).resolve().parents[2] / "templates" / "valorant" / "icons"
PROFILE = load_valorant_profile(TEMPLATES)
CX, CY, CW, CH = BANNER_REF  # feed() draws the reference crop the detector reads.

RED = (70, 80, 240)      # BGR
TEAL = (170, 200, 90)
YELLOW = (80, 225, 235)
BACKGROUND = (60, 70, 80)


def feed(*rows, blobs=()):
    """rows: (slot, killer_team, victim_team, self_at) with self_at in {None, 'left', 'right', 'both'}."""
    img = np.full((CH, CW, 3), BACKGROUND, np.uint8)
    right = RIGHT_EDGE - CX
    for slot, killer, victim, self_at in rows:
        cy = ROW_Y0 + ROW_STEP * slot - CY
        y0, y1 = cy - ROW_H // 2, cy + ROW_H // 2
        left = right - 330
        mid = right - 150
        cv2.rectangle(img, (left, y0), (mid, y1 - 1), killer, -1)
        cv2.rectangle(img, (mid, y0), (right - 1, y1 - 1), victim, -1)
        cv2.putText(img, "name", (right - 120, y1 - 9), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
        if self_at in ("left", "both"):
            cv2.rectangle(img, (left, y0), (left + 34, y1 - 1), YELLOW, -1)
            cv2.rectangle(img, (left + 8, y0 + 6), (left + 26, y1 - 7), (90, 110, 140), -1)  # Portrait inside the box.
        if self_at in ("right", "both"):
            cv2.rectangle(img, (right - 34, y0), (right - 1, y1 - 1), YELLOW, -1)
            cv2.rectangle(img, (right - 26, y0 + 6), (right - 8, y1 - 7), (90, 110, 140), -1)
    for (x, y, w, h) in blobs:
        cv2.rectangle(img, (x, y), (x + w, y + h), YELLOW, -1)
    return img


def kinds(img):
    return [(r.slot, r.type) for r in FeedDetector(PROFILE).rows(img)]


def test_the_players_box_and_the_victims_team_decide_kill_or_death():
    assert kinds(feed((0, TEAL, RED, "left"))) == [(0, "kill")]
    assert kinds(feed((1, RED, TEAL, "right"))) == [(1, "death")]
    assert kinds(feed((0, RED, TEAL, None), (1, TEAL, RED, None))) == []  # Other players' rows.


def outline_feed(slot, killer, victim, side):
    """Newer clients: a thin yellow outline along the player's half and a chevron just outside the row end."""
    img = feed((slot, killer, victim, None))
    right = RIGHT_EDGE - CX
    cy = ROW_Y0 + ROW_STEP * slot - CY
    y0, y1 = cy - ROW_H // 2, cy + ROW_H // 2
    x0, x1 = (right - 330, right - 180) if side == "left" else (right - 150, right - 1)
    cv2.line(img, (x0, y0), (x1, y0), YELLOW, 2)
    cv2.line(img, (x0, y1 - 1), (x1, y1 - 1), YELLOW, 2)
    tip = x0 - 10 if side == "left" else right + 2
    pts = np.array([[tip + (8 if side == "left" else 0), cy - 9], [tip + (0 if side == "left" else 8), cy],
                    [tip + (8 if side == "left" else 0), cy + 9]], np.int32)
    cv2.fillPoly(img, [pts], YELLOW)
    return img


def test_the_newer_outline_and_chevron_style_marks_the_player_too():
    assert kinds(outline_feed(1, TEAL, RED, "left")) == [(1, "kill")]
    assert kinds(outline_feed(2, RED, TEAL, "right")) == [(2, "death")]


def test_killing_yourself_is_a_death_not_a_kill():
    assert kinds(feed((0, TEAL, TEAL, "both"))) == [(0, "death")]


def test_yellow_without_a_matching_row_or_team_is_ignored():
    # A box on an enemy-kills-ally row's killer end is scenery bleeding through, not the player.
    assert kinds(feed((0, RED, TEAL, "left"))) == []
    # Scenery with no row behind it, and an assist-sized mini portrait, are not portrait boxes.
    assert kinds(feed(blobs=[(200, 150, 34, 30)])) == []
    assert kinds(feed((0, TEAL, RED, None), blobs=[(RIGHT_EDGE - CX - 360, ROW_Y0 - CY - 9, 18, 18)])) == []


def row(slot, kind, sig):
    v = np.asarray(sig, np.float32)
    return FeedRow(slot, kind, v / np.linalg.norm(v))


def test_one_entry_is_one_event_while_it_flickers_and_moves_up():
    tr = FeedTracker()
    a, b = [1, 0, 0], [0, 1, 0]
    assert [e.type for e in tr.feed(0.0, [row(1, "kill", a)])] == ["kill"]
    assert tr.feed(0.5, []) == []                       # Faded out for a moment.
    assert tr.feed(1.0, [row(1, "kill", a)]) == []
    assert tr.feed(3.0, [row(0, "kill", a)]) == []      # Older row expired; this one moved up.
    assert len(tr.feed(3.5, [row(0, "kill", a), row(1, "kill", b)])) == 1  # A second kill below it.
    assert [e.t for e in tr.events] == [0.0, 3.5]


def test_a_returning_death_row_with_another_look_is_still_one_death():
    tr = FeedTracker()
    tr.feed(10.0, [row(2, "death", [1, 0, 0])])
    tr.feed(14.0, [row(3, "death", [0, 0, 1])])        # Different slot and look, within the death gap.
    tr.feed(40.0, [row(0, "death", [0, 1, 0])])        # Next round.
    assert [e.t for e in tr.events] == [10.0, 40.0]
    assert all(e.type == "death" and not e.counted and e.counted_reason == "death" for e in tr.events)


def test_the_top_scoreboard_identifies_valorant_footage():
    top = np.zeros((80, 1920, 3), np.uint8)
    assert not scoreboard_visible(top)
    x, y, w, h = SCORE_BOX
    top[y:y + h, x:x + w] = (150, 140, 140)  # Translucent grey score box.
    x, y, w, h = ENEMY_STRIP
    top[y:y + h, x:x + w] = RED
    assert scoreboard_visible(top)            # One strip is enough: the other may be washed out.
    x, y, w, h = SCORE_BOX
    top[y:y + h, x:x + w] = TEAL
    assert not scoreboard_visible(top)        # A saturated block where the grey box should be is something else.


def test_profile_must_cover_the_kill_feed(tmp_path):
    (tmp_path / "profile.json").write_text(
        '{"templates_version": "x", "capture_rois": {"banner": [1436, 300, 480, 100], "spec": [0, 0, 10, 10]}}',
        encoding="utf-8")
    with pytest.raises(ValorantProfileError, match="every aspect"):
        load_valorant_profile(tmp_path)


def captured(ref: np.ndarray) -> np.ndarray:
    """A reference feed crop placed in the wider capture crop aditorrec hands over (16:9 game)."""
    bx, _, bw, _ = PROFILE.capture_banner
    img = np.full((CH, bw, 3), BACKGROUND, np.uint8)
    img[:, CX - bx:CX - bx + CW] = ref
    return img


def _live_frames():
    """4 fps: a kill row from 1 s to 5 s, then a death row from 10 s to 14 s."""
    for k in range(64):
        t = k * 0.25
        rows = [(0, TEAL, RED, "left")] if 1 <= t < 5 else [(0, RED, TEAL, "right")] if 10 <= t < 14 else []
        yield t, captured(feed(*rows))


def test_live_engine_reports_valorant_kills_and_deaths():
    from test_live import FakeClock, ShmTestWriter, _name, _pts

    lay = ShmLayout(tuple(PROFILE.capture_banner[2:]), tuple(PROFILE.capture_spec[2:]), (640, 360))
    spec = np.zeros((lay.spec[1], lay.spec[0], 3), np.uint8)
    name, out, clock = _name(), [], FakeClock()
    w = ShmTestWriter(name, lay)
    r = ShmReader.open(name)
    eng = LiveEngine(r, PROFILE, None, out.append, clock=clock, kills=ValorantLiveKills(PROFILE))
    try:
        for t, banner in _live_frames():
            w.write(_pts(t), banner, spec, None)
            clock.now += 0.25
            assert eng.poll() == 1
        eng.finish()
    finally:
        r.close()
        w.close()
    final = [o for o in out if o["ev"] == "snapshot" and o.get("final")][-1]
    assert [(e["type"], e["t"]) for e in final["events"]] == [("kill", 1.0), ("death", 10.0)]
    assert final["quality"]["complete"] is True
    assert not [o for o in out if o["ev"].startswith("match_")]


def test_live_run_accepts_valorant_shared_memory():
    import io
    import json as _json
    from test_live import ShmTestWriter, _name, _pts

    lay = ShmLayout(tuple(PROFILE.capture_banner[2:]), tuple(PROFILE.capture_spec[2:]), (640, 360))
    name = _name()
    w = ShmTestWriter(name, lay)
    try:
        spec = np.zeros((lay.spec[1], lay.spec[0], 3), np.uint8)
        for t, banner in list(_live_frames())[4:12]:  # The kill row, within the start-up backlog.
            w.write(_pts(t), banner, spec, None)
        out = io.BytesIO()
        assert run_live(name, TEMPLATES, stdin=io.BytesIO(), stdout=out, game="valorant", poll_interval=0.01) == 0
    finally:
        w.close()
    lines = [_json.loads(x) for x in out.getvalue().decode("utf-8").splitlines()]
    assert lines[0]["ev"] == "ready"
    final = [o for o in lines if o["ev"] == "snapshot" and o.get("final")][-1]
    assert [e["type"] for e in final["events"]] == ["kill"]


def test_derive_never_counts_a_death_as_a_kill():
    from aditor.derive import derive
    from aditor.models import Event
    from aditor.profile import load_profile
    from conftest import ICON_DIR

    events = [Event(id=f"v{i}", t=float(i), type=typ, score=1.0, damage_line=False, name_sig=None, counted=True)
              for i, typ in enumerate(("kill", "kill", "death"))]
    out = derive(events, [], load_profile(ICON_DIR))
    assert [(e.type, e.counted, e.counted_reason) for e in out] == [
        ("kill", True, "first"), ("kill", True, "first"), ("death", False, "death")]


def test_two_kills_in_one_frame_get_distinct_ids():
    tr = FeedTracker()
    tr.feed(5.0, [row(0, "kill", [1, 0, 0]), row(1, "kill", [0, 1, 0])])
    assert len({e.id for e in tr.events}) == 2


def test_reanalysis_recomputes_multikills_from_the_users_kill_edits():
    from dataclasses import replace

    from aditor.models import Event
    from aditor.valorant import merge_events
    from aditor.valorant_rounds import Round, round_highlights

    def kill(t):
        return Event(id=f"k{t}", t=t, type="kill", score=1.0, damage_line=False, name_sig=None, counted=True,
                     counted_reason="first")

    rounds = [Round(0, 100, "ally", 1, 0)]
    detected = [kill(10.0), kill(20.0)]
    first = detected + round_highlights(detected, rounds)
    assert [e.type for e in first].count("multikill") == 1
    edited = [replace(e, deleted=True) if e.t == 20.0 and e.type == "kill" else e for e in first]
    events, _ = merge_events(edited, [kill(10.0), kill(20.0)], rounds)
    assert [e.type for e in events if not e.deleted] == ["kill"]

    hidden = [replace(e, deleted=True) if e.type == "multikill" else e for e in first]
    events, _ = merge_events(hidden, [kill(10.0), kill(20.0)], rounds)
    assert [(e.type, e.deleted) for e in events if e.type == "multikill"] == [("multikill", True)]


def _frame_strip(ref: np.ndarray, aspect: float, letterbox: bool) -> np.ndarray:
    """The banner capture of a game rendered at `aspect`: its HUD keeps the 1080p pixel size in a canvas 1080 * aspect
    wide, which is stretched to 1920 or centred between black bars."""
    full = np.full((CH, 1920, 3), BACKGROUND, np.uint8)
    full[:, CX:CX + CW] = ref
    canvas_w = round(1080 * aspect)
    canvas = full[:, 1920 - canvas_w:]
    if letterbox:
        frame = np.zeros_like(full)
        left = (1920 - canvas_w) // 2
        frame[:, left:left + canvas_w] = canvas
    else:
        frame = cv2.resize(canvas, (1920, CH), interpolation=cv2.INTER_LINEAR)
    bx, _, bw, _ = PROFILE.capture_banner
    return frame[:, bx:bx + bw]


@pytest.mark.parametrize("letterbox", [False, True])
@pytest.mark.parametrize("aspect_text", ["4:3", "16:10", "5:4"])
def test_narrower_render_aspects_read_the_same_kill_feed(aspect_text, letterbox):
    from aditor.layout import parse_aspect

    profile = PROFILE.with_layout(parse_aspect(aspect_text))
    ref = feed((0, TEAL, RED, "left"), (2, RED, TEAL, "right"))
    banner = _frame_strip(ref, profile.aspect, letterbox)
    spec = np.zeros((PROFILE.capture_spec[3], PROFILE.capture_spec[2], 3), np.uint8)
    assert profile.letterboxed(banner) is letterbox
    restored, restored_spec = profile.restore(banner, spec)
    assert restored.shape == ref.shape and restored_spec.shape[1] == 460
    assert [(r.slot, r.type) for r in FeedDetector(profile).rows(restored)] == [(0, "kill"), (2, "death")]


def test_the_same_victim_killed_again_after_the_entry_left_is_a_new_kill():
    tr = FeedTracker()
    sig = [1, 0, 0]
    for t in (250.0, 251.0, 252.0, 253.0, 254.0, 255.0):
        tr.feed(t, [row(0, "kill", sig)])
    tr.feed(260.0, [row(3, "kill", sig)])               # Looks alike, but the first entry has left the feed.
    assert [e.t for e in tr.events] == [250.0, 260.0]


def test_a_stray_row_in_the_slot_above_does_not_split_an_entry():
    tr = FeedTracker()
    a = [1, 0, 0]
    tr.feed(10.0, [row(2, "kill", a)])
    tr.feed(10.25, [row(1, "kill", [0, 1, 0]), row(2, "kill", a)])  # A one-frame copy while the row slides.
    tr.feed(10.5, [row(2, "kill", a)])
    assert [e.t for e in tr.events] == [10.0]


def test_a_short_box_counts_only_with_the_outline_along_the_row():
    def short_box(outline):
        img = feed((1, TEAL, RED, None))
        right = RIGHT_EDGE - CX
        cy = ROW_Y0 + ROW_STEP - CY
        y0, y1 = cy - ROW_H // 2, cy + ROW_H // 2
        left = right - 330
        cv2.rectangle(img, (left, y0 + 3), (left + 23, y0 + 25), YELLOW, -1)  # 23 px tall: below MIN_BOX_H.
        if outline:
            cv2.line(img, (left + 26, y0), (right - 180, y0), YELLOW, 2)
        return img

    assert kinds(short_box(outline=True)) == [(1, "kill")]
    assert kinds(short_box(outline=False)) == []


def test_compressed_player_row_is_recognized_before_its_outline_becomes_stronger():
    # Real 33.25 s frame: dense 22x24 portrait, 36 outline columns and a clear
    # row edge. The old 40-column gate postponed this kill until 34.25 s.
    strip = cv2.imread(str(Path(__file__).parent / "fixtures/valorant/compact-player-row.png"))
    assert strip is not None
    img = np.zeros((CH, CW, 3), np.uint8)
    img[80:140] = strip
    assert kinds(img) == [(2, "kill")]


def test_one_second_timing_correction_preserves_the_users_event_edits():
    from aditor.models import Event
    from aditor.valorant import merge_events

    old = Event(id="old", t=34.25, type="kill", score=1, damage_line=False, name_sig=None,
                deleted=True, counted_override=False)
    detected = Event(id="new", t=33.25, type="kill", score=1, damage_line=False, name_sig=None)
    merged, unmatched = merge_events([old], [detected], [])
    assert unmatched == []
    assert len(merged) == 1
    assert merged[0].t == 33.25
    assert merged[0].deleted is True
    assert merged[0].counted_override is False


def test_unconfirmed_rows_never_create_events():
    from dataclasses import replace

    tr = FeedTracker()
    for k in range(40):
        assert tr.feed(k * 0.25, [replace(row(0, "kill", [1, 0, 0]), confirmed=False)]) == []
    assert tr.events == []


def test_late_self_marker_backdates_only_the_same_observed_row():
    from dataclasses import replace

    tr = FeedTracker()
    weak = replace(row(2, "kill", [1, 0, 0]), confirmed=False)
    tr.feed(10, [weak])
    tr.feed(10.25, [weak])
    assert tr.feed(10.5, [row(1, "kill", [1, 0, 0])])[0].t == 10


def test_an_unrelated_weak_row_cannot_move_a_kill_earlier():
    from dataclasses import replace

    tr = FeedTracker()
    tr.feed(10, [replace(row(0, "kill", [1, 0, 0]), confirmed=False)])
    assert tr.feed(10.25, [row(0, "kill", [0, 1, 0])])[0].t == 10.25


def test_a_gap_breaks_the_weak_timestamp_evidence_chain():
    from dataclasses import replace

    tr = FeedTracker()
    tr.feed(10, [replace(row(0, "kill", [1, 0, 0]), confirmed=False)])
    tr.feed(10.25, [])
    tr.feed(10.5, [])
    assert tr.feed(11, [row(0, "kill", [1, 0, 0])])[0].t == 11


def test_a_new_victim_at_the_same_slot_is_not_discarded_as_flicker():
    from dataclasses import replace

    tr = FeedTracker()
    first = replace(row(0, "kill", [1, 0, 0]), identity=np.array([1, 0], np.float32))
    second = replace(row(0, "kill", [0, 1, 0]), identity=np.array([0, 1], np.float32))
    tr.feed(10, [first])
    assert tr.feed(10.25, [second]) == []
    assert tr.feed(10.5, [second])[0].t == 10.25
    assert [e.t for e in tr.events] == [10, 10.25]


def test_unreadable_victim_with_a_changing_background_is_one_kill():
    detector = FeedDetector(PROFILE)
    b0, b1 = detector.band(0)
    observations = []
    for inverse in (False, True):
        img = feed((0, TEAL, RED, "left"))
        # Preserve the player marker, team hue and row edges while changing
        # the scenery visible through the victim panel. No glyphs are readable.
        for x in range(detector.right - 150, detector.right):
            bright = ((x - detector.right + 150) < 75) ^ inverse
            img[b0 + 3:b1 - 3, x] = (110, 120, 250) if bright else (5, 10, 120)
        rows = detector.observations(img)
        assert len(rows) == 1 and rows[0].confirmed and rows[0].identity is None
        observations.append(rows)
    tr = FeedTracker()
    for t, index in ((10, 0), (10.25, 1), (10.5, 1), (10.75, 0)):
        tr.feed(t, observations[index])
    assert [e.t for e in tr.events] == [10]


def test_a_one_frame_appearance_change_does_not_duplicate_a_kill():
    tr = FeedTracker()
    tr.feed(10, [row(0, "kill", [1, 0, 0])])
    assert tr.feed(10.25, [row(0, "kill", [0, 1, 0])]) == []
    assert tr.feed(10.5, [row(0, "kill", [1, 0, 0])]) == []
    assert len(tr.events) == 1


def test_a_readable_new_victim_after_unreadable_frames_starts_a_new_kill():
    from dataclasses import replace

    tr = FeedTracker()
    first = replace(row(0, "kill", [1, 0, 0]), identity=np.array([1, 0], np.float32))
    unreadable = row(0, "kill", [0, 1, 0])
    second = replace(row(0, "kill", [0, 0, 1]), identity=np.array([0, 1], np.float32))
    tr.feed(10, [first])
    assert tr.feed(10.25, [unreadable]) == []
    assert tr.feed(10.5, [unreadable]) == []
    assert tr.feed(10.75, [second]) == []
    assert tr.feed(11, [second])[0].t == 10.75
    assert [e.t for e in tr.events] == [10, 10.75]


def test_unreadable_new_victim_after_a_gap_is_not_merged_by_slot():
    tr = FeedTracker()
    tr.feed(10, [row(0, "kill", [1, 0, 0])])
    assert tr.feed(12, [row(0, "kill", [0, 1, 0])])[0].t == 12
    assert [e.t for e in tr.events] == [10, 12]


def test_identical_victim_in_a_new_lower_row_is_a_distinct_kill():
    tr = FeedTracker()
    tr.feed(10, [row(0, "kill", [1, 0, 0])])
    assert tr.feed(10.25, [row(0, "kill", [1, 0, 0]), row(1, "kill", [1, 0, 0])])[0].t == 10.25
    assert len(tr.events) == 2


def test_glyph_identity_can_keep_a_row_through_background_changes():
    from dataclasses import replace

    tr = FeedTracker()
    first = replace(row(1, "kill", [1, 0, 0]), identity=np.array([1, 0], np.float32))
    changed = replace(row(0, "kill", [0, 1, 0]), identity=np.array([1, 0], np.float32))
    tr.feed(10, [first])
    assert tr.feed(10.25, [changed]) == []
    assert len(tr.events) == 1


def test_other_players_feed_rows_are_only_unconfirmed_observations():
    detector = FeedDetector(PROFILE)
    observations = detector.observations(feed((0, TEAL, RED, None), (1, RED, TEAL, None)))
    assert [(r.slot, r.type, r.confirmed) for r in observations] == [(0, "kill", False), (1, "death", False)]
    tr = FeedTracker()
    tr.feed(10, observations)
    assert tr.events == []


def test_large_backdate_keeps_unmatched_user_edits_for_review():
    from aditor.models import Event
    from aditor.valorant import merge_events

    old = Event(id="old", t=12, type="kill", score=1, damage_line=False,
                name_sig=None, deleted=True)
    detected = Event(id="new", t=10, type="kill", score=1, damage_line=False, name_sig=None)
    merged, unmatched = merge_events([old], [detected], [])
    assert [e.id for e in unmatched] == ["old"]
    assert len(merged) == 1 and not merged[0].deleted


def _recorded_feed(name):
    strip = cv2.imread(str(Path(__file__).parent / "fixtures/valorant" / f"{name}.png"))
    assert strip is not None
    img = np.zeros((CH, CW, 3), np.uint8)
    img[:strip.shape[0]] = strip
    return img


def test_yellow_clothes_and_bright_scenery_are_not_a_player_marker():
    assert kinds(_recorded_feed("yellow-clothing-background")) == []
    assert kinds(_recorded_feed("outlined-player-background")) == [(1, "kill")]
    assert kinds(_recorded_feed("faint-player-chevron")) == [(1, "kill")]
    assert kinds(_recorded_feed("sparse-player-chevrons")) == [(1, "kill"), (2, "kill")]


def test_same_victim_after_sustained_empty_feed_starts_at_first_sighting():
    detector = FeedDetector(PROFILE)
    rows = detector.observations(_recorded_feed("same-victim-after-cut"))
    assert [(r.slot, r.type, r.confirmed) for r in rows] == [(0, "kill", True)]
    tr = FeedTracker()
    tr.feed(170.75, rows)
    tr.feed(174.5, rows)
    for t in np.arange(174.75, 177.25, 0.25):
        tr.feed(float(t), [])
    assert tr.feed(177.25, rows)[0].t == 177.25
    assert [e.t for e in tr.events] == [170.75, 177.25]


def test_yellow_highlight_in_the_victim_half_is_not_a_kill_marker():
    right = RIGHT_EDGE - CX
    assert kinds(feed((0, TEAL, RED, None),
                      blobs=[(right - 110, ROW_Y0 - CY - 15, 25, 30)])) == []


def test_one_unreadable_row_among_visible_rows_keeps_its_track():
    tr = FeedTracker()
    first, second = row(0, "kill", [1, 0, 0]), row(1, "kill", [0, 1, 0])
    tr.feed(10, [first, second])
    for t in np.arange(10.25, 12.5, 0.25):
        tr.feed(float(t), [first])
    assert tr.feed(12.5, [first, second]) == []
    assert len(tr.events) == 2
