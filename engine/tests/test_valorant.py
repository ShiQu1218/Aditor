from pathlib import Path

import cv2
import numpy as np
import pytest

from aditor.live import LiveEngine, ShmLayout, ShmReader, run as run_live
from aditor.valorant import (ValorantLiveKills, ALLY_STRIP, ENEMY_STRIP, SCORE_BOX, ROW_H, ROW_STEP, ROW_Y0, RIGHT_EDGE, FeedDetector,
                             FeedRow, FeedTracker, ValorantProfileError, load_valorant_profile, scoreboard_visible)

TEMPLATES = Path(__file__).resolve().parents[2] / "templates" / "valorant" / "icons"
PROFILE = load_valorant_profile(TEMPLATES)
CX, CY, CW, CH = PROFILE.capture_banner

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
    with pytest.raises(ValorantProfileError, match="kill feed"):
        load_valorant_profile(tmp_path)


def _live_frames():
    """4 fps: a kill row from 1 s to 5 s, then a death row from 10 s to 14 s."""
    for k in range(64):
        t = k * 0.25
        rows = [(0, TEAL, RED, "left")] if 1 <= t < 5 else [(0, RED, TEAL, "right")] if 10 <= t < 14 else []
        yield t, feed(*rows)


def test_live_engine_reports_valorant_kills_and_deaths():
    from test_live import FakeClock, ShmTestWriter, _name, _pts

    lay = ShmLayout((CW, CH), tuple(PROFILE.capture_spec[2:]), (640, 360))
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

    lay = ShmLayout((CW, CH), tuple(PROFILE.capture_spec[2:]), (640, 360))
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
