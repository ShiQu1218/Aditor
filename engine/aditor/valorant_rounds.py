"""Valorant rounds from the top scoreboard, and multi-kill / ace highlights per round.

The `spec` crop of templates/valorant/icons/profile.json covers the top scoreboard. Beside the round timer sit the
ally score and the enemy score as white digits on translucent grey boxes; a side's digits turning into a new glyph
that holds means that side won the round. The boxes take the background's brightness, so digits are thresholded above
the box's own median. Scores only go up within a match, so a glyph seen before is noise (a flash or a bright sky), and
every round opens with a 30 s buy phase, so round ends closer than MIN_ROUND_GAP are noise too. A scoreboard absent for
MATCH_GAP means the match is over; the next one starts from 0 again.

Tuned on a stream VOD (3 matches, 22/24/19 rounds): 21/25/20 rounds found.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import cv2
import numpy as np

from .models import Event

# Score digit boxes (x, y, w, h) on the 1920x1080 frame.
ALLY_DIGITS = (800, 34, 52, 32)
ENEMY_DIGITS = (1072, 34, 52, 32)
STABLE_SECONDS = 2.0     # a new glyph must hold this long
LAST_ROUND_SECONDS = 0.75  # ...unless the scoreboard then vanishes: the match-winning round's score shows only briefly
END_CONFIRM_SECONDS = 15.0  # ...for good: it also vanishes briefly mid-match (the Tab scoreboard, spectating)
MIN_INK, MAX_INK = 30, 700
MAX_BOX_SATURATION = 70  # the score box is grey; deathmatch puts coloured player tiles (their kill counts) there
# Deathmatch is free-for-all: every player tile beside the timer is an enemy's (red), while in round modes the ally
# side is teal or empty. Red just left of the ally score box therefore means there are no rounds to read.
ALLY_SIDE = (742, 34, 54, 30)
MAX_ALLY_SIDE_RED = 0.10
SAME = 0.75              # glyph mask IoU at which two readings are the same digits
MIN_ROUND_GAP = 25.0
MATCH_GAP = 60.0
WIN_SCORE = 13           # first to 13 wins; from 12:12 overtime runs until one side leads by 2
ROUND_TAIL = 3.0         # kill-feed rows can land just after the score changes
ACE = 5


@dataclass
class Round:
    start: float
    end: float
    winner: str          # "ally" | "enemy"
    ally: int            # score after the round
    enemy: int

    def to_dict(self) -> dict:
        return asdict(self)


class _Side:
    def __init__(self):
        self.reset()

    def reset(self) -> None:
        self.stable: np.ndarray | None = None
        self.cand: np.ndarray | None = None
        self.count = 0
        self.seen: list[np.ndarray] = []


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    return float((a & b).sum()) / max(1, int((a | b).sum()))


class RoundTracker:
    """Feed the `spec` crop (origin at the profile's capture_spec x/y) at a steady frame rate."""

    def __init__(self, origin: tuple[int, int], fps: float = 4.0):
        self.ox, self.oy = origin
        self.stable_frames = max(1, round(STABLE_SECONDS * fps))
        self.last_round_frames = max(1, round(LAST_ROUND_SECONDS * fps))
        self._frame = 1.0 / fps
        self._pending: tuple[str, float, float, np.ndarray] | None = None  # (side, round end, vanished at, glyph)
        self.sides = {"ally": _Side(), "enemy": _Side()}
        self.rounds: list[Round] = []
        self._match_start: float | None = None
        self._last_seen: float | None = None
        self._score = {"ally": 0, "enemy": 0}

    def _glyph(self, crop: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray | None:
        x, y, w, h = box
        region = crop[y - self.oy:y - self.oy + h, x - self.ox:x - self.ox + w]
        if region.shape[0] != h or region.shape[1] != w:
            return None
        hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
        v = hsv[..., 2].astype(np.int16)
        mask = (v >= max(200, int(np.median(v)) + 45)) & (hsv[..., 1] <= 50)
        if not MIN_INK <= int(mask.sum()) <= MAX_INK:
            return None
        # Rounds exist only where the grey score box is; a coloured background is deathmatch's player tiles.
        return mask if float(hsv[..., 1][~mask].mean()) <= MAX_BOX_SATURATION else None

    def _deathmatch(self, crop: np.ndarray) -> bool:
        x, y, w, h = ALLY_SIDE
        region = crop[y - self.oy:y - self.oy + h, max(0, x - self.ox):x - self.ox + w]
        if region.size == 0:
            return False
        hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
        hue = hsv[..., 0]
        red = ((hue <= 10) | (hue >= 170)) & (hsv[..., 1] >= 60) & (hsv[..., 2] >= 90)
        return float(red.mean()) >= MAX_ALLY_SIDE_RED

    def feed(self, t: float, crop: np.ndarray) -> Round | None:
        if self._deathmatch(crop):
            return None
        glyphs = {"ally": self._glyph(crop, ALLY_DIGITS), "enemy": self._glyph(crop, ENEMY_DIGITS)}
        if all(g is None for g in glyphs.values()):
            if self._pending is None:
                self._pending = self._final_candidate(t)
            final = None
            if self._pending is not None and t - self._pending[2] >= END_CONFIRM_SECONDS:
                name, at, _, glyph = self._pending
                self._pending = None
                side = self.sides[name]
                side.seen.append(glyph)
                side.stable, side.cand, side.count = glyph, None, 0
                final = self._won(name, at)
            if self._last_seen is not None and t - self._last_seen > MATCH_GAP:
                self._new_match()
            return final
        self._pending = None  # The scoreboard came back: it only vanished for a moment.
        if self._last_seen is None or t - self._last_seen > MATCH_GAP:
            self._new_match()
        self._last_seen = t
        if self._match_start is None:
            self._match_start = t
        if self._decided():  # Score changes after the match is decided come from the end-of-match screens.
            return None
        won = None
        for name, g in glyphs.items():
            if g is not None and self._update(self.sides[name], g) and won is None:
                won = name
        if won is None:
            return None
        return self._won(won, t - (self.stable_frames - 1) * self._frame)

    def _final_candidate(self, t: float) -> tuple[str, float, float, np.ndarray] | None:
        """As the scoreboard vanishes: a fresh glyph that held briefly may be the match-winning round's score."""
        if self._match_start is None or self._decided():
            return None
        for name, side in self.sides.items():
            if side.cand is not None and side.count >= self.last_round_frames and side.stable is not None and                     not any(_iou(side.cand, old) >= SAME for old in side.seen):
                return name, t - self._frame * side.count, t, side.cand
        return None

    def _won(self, name: str, at: float) -> Round | None:
        last_end = self.rounds[-1].end if self.rounds and self.rounds[-1].start >= self._match_start else None
        if last_end is not None and at - last_end < MIN_ROUND_GAP:
            return None
        self._score[name] += 1
        rnd = Round(start=last_end if last_end is not None else self._match_start, end=round(at, 3), winner=name,
                    ally=self._score["ally"], enemy=self._score["enemy"])
        self.rounds.append(rnd)
        return rnd

    def _decided(self) -> bool:
        a, e = self._score["ally"], self._score["enemy"]
        return max(a, e) >= WIN_SCORE and abs(a - e) >= 2

    def _new_match(self) -> None:
        self._pending = None
        for side in self.sides.values():
            side.reset()
        self._match_start = None
        self._score = {"ally": 0, "enemy": 0}

    def _update(self, side: _Side, g: np.ndarray) -> bool:
        """True when a new score glyph has held long enough (the side won a round)."""
        if side.stable is not None and _iou(g, side.stable) >= SAME:
            side.cand, side.count = None, 0
            return False
        if side.cand is not None and _iou(g, side.cand) >= SAME:
            side.count += 1
        else:
            side.cand, side.count = g, 1
        if side.count < self.stable_frames:
            return False
        new, side.cand, side.count = side.cand, None, 0
        first = side.stable is None  # The match's opening score is the baseline, not a won round.
        side.stable = new
        if any(_iou(new, old) >= SAME for old in side.seen):
            return False
        side.seen.append(new)
        return not first


def round_highlights(events: list[Event], rounds: list[Round]) -> list[Event]:
    """One multikill (2-4 kills) or ace (5) event per round, at the round's last kill; never counted as kills."""
    out = []
    assigned_ids: set[str] = set()
    for rnd in rounds:
        kills = sorted((e for e in events if e.type == "kill" and not e.deleted and
                        (e.counted_override if e.counted_override is not None else e.counted) and
                        e.id not in assigned_ids and rnd.start <= e.t < rnd.end + ROUND_TAIL), key=lambda e: e.t)
        # Keep delayed kills on the earlier round without sharing the tail with the next round.
        assigned_ids.update(e.id for e in kills)
        if len(kills) < 2:
            continue
        kind = "ace" if len(kills) >= ACE else "multikill"
        last = kills[-1]
        out.append(Event(id=f"r{int(round(last.t * 1000))}", t=last.t, type=kind, score=float(len(kills)),
                         damage_line=False, name_sig=None, counted=False, counted_reason="highlight"))
    return out
