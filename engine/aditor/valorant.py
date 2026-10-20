"""Valorant kill/death detection from the kill feed (templates/valorant/icons/profile.json).

The kill feed sits at the top right: rows right-aligned at x~1902, the first centred at y~112, 40 px apart, ~30 px tall
(1920x1080 reference). Each row reads killer -> victim, each side filled with its team colour (red = enemy, teal =
ally). The local player's portrait box is solid yellow: at the row's left end for their kill, at the right end (with
a chevron outside it) for their death.

Detection is by shape rather than colour alone, because rows are translucent and ability effects or neon scenery are
yellow too: a portrait-sized yellow box must sit inside one row band, the row must have crisp top/bottom edges, and the
victim's team decides the event (the player only kills enemies, and dies as an ally; killing yourself, e.g. with
Clove's ability, is a death). Tuned on a 1080p60 stream VOD: 3 matches, 53 kills and 55 deaths on the scoreboards.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

import cv2
import numpy as np

from . import ENGINE_VERSION
from .cache import cache_path, load_cache, merge_clips, merge_reanalysis, needs_reanalysis, save_cache
from .decode import FrameStream
from .errors import Cancelled
from .layout import Layout
from .models import Clip, Event, VideoInfo
from .probe import keyframes
from .valorant_rounds import Round, RoundTracker, round_highlights

GAME = "valorant"

# Detection constants on the 1920x1080 reference frame.
ROW_Y0, ROW_STEP, ROW_H, ROWS = 112, 40, 30, 6
RIGHT_EDGE = 1902
MIN_BOX_H = 28
MIN_ROW_EDGE = 45.0
MIN_TEAM_FILL = 0.30
# Newer clients mark the player's row with a thin yellow outline along their half and a chevron outside the row end
# instead of a solid portrait box. The chevron is a narrow upright triangle (~9x19; assist mini-portraits are squarer)
# and the outline next to it shows a row is there, so a lower edge contrast suffices (overlays such as the performance
# graphs soften the row edges).
MIN_OUTLINE = 40
MIN_CHEVRON_ROW_EDGE = 25.0

# Tracking: one kill-feed entry may flicker while fading and moves up a slot when an older row expires.
SAME_ENTRY = 0.80   # Row signature correlation above which two sightings are the same entry.
ENTRY_LIFE = 7.0    # Seconds an entry can stay on screen.
FLICKER = 1.5       # Seconds a row may vanish and return at its slot (or one below) as the same entry.
DEATH_GAP = 6.0     # Minimum seconds between two deaths (Clove can revive and die again within a round).


class ValorantProfileError(Exception):
    pass


@dataclass(frozen=True)
class ValorantProfile:
    """Crop rects in the shape FrameStream expects of a Profile; restore() keeps the crops unchanged (16:9 only)."""
    templates_version: str
    capture_banner: tuple[int, int, int, int]
    capture_spec: tuple[int, int, int, int]
    dir: Path = field(default_factory=Path)
    layout: Layout = Layout(1.0)

    @property
    def origin(self) -> tuple[int, int]:
        return self.capture_banner[0], self.capture_banner[1]

    def restore(self, banner, spec):
        return banner, spec


def load_valorant_profile(dir: Path) -> ValorantProfile:
    pj = Path(dir) / "profile.json"
    try:
        doc = json.loads(pj.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise ValorantProfileError(f"profile.json does not exist: {pj}") from e
    except json.JSONDecodeError as e:
        raise ValorantProfileError(f"Invalid profile.json: {e}") from e
    try:
        version = doc["templates_version"]
        banner = tuple(int(v) for v in doc["capture_rois"]["banner"])
        spec = tuple(int(v) for v in doc["capture_rois"]["spec"])
    except (KeyError, TypeError, ValueError) as e:
        raise ValorantProfileError(f"profile.json is missing a field: {e}") from e
    if not isinstance(version, str) or not version or len(banner) != 4 or len(spec) != 4:
        raise ValorantProfileError("profile.json has an invalid templates_version or capture_rois")
    bx, by, bw, bh = banner
    # The feed crop must contain every row band and the right edge the rules measure against.
    if bx > RIGHT_EDGE - 220 or bx + bw < RIGHT_EDGE or by > ROW_Y0 - ROW_H // 2 - 4 or \
            by + bh < ROW_Y0 + ROW_STEP * (ROWS - 1) + ROW_H // 2 + 4:
        raise ValorantProfileError(f"capture_rois.banner {banner} does not cover the kill feed")
    return ValorantProfile(version, banner, spec, Path(dir))  # type: ignore[arg-type]


# ---- Per-frame detection (feed crop coordinates) ----

def _row_band(k: int, cy0: int) -> tuple[int, int]:
    cy = ROW_Y0 + ROW_STEP * k - cy0
    return cy - ROW_H // 2, cy + ROW_H // 2


@dataclass(frozen=True)
class FeedRow:
    slot: int
    type: str            # "kill" | "death"
    signature: np.ndarray


class FeedDetector:
    def __init__(self, profile: ValorantProfile):
        self.cx, self.cy = profile.origin
        self.right = RIGHT_EDGE - self.cx

    def band(self, k: int) -> tuple[int, int]:
        return _row_band(k, self.cy)

    def _row_edge(self, gray: np.ndarray, k: int) -> float:
        """Vertical contrast at the row's top and bottom edges over its right end, where every row has its victim side."""
        b0, b1 = self.band(k)
        xs = slice(self.right - 140, self.right - 4)
        return float(np.abs(gray[b0 + 2, xs] - gray[b0 - 3, xs]).mean() + np.abs(gray[b1 - 2, xs] - gray[b1 + 3, xs]).mean())

    def _victim_team(self, hsv: np.ndarray, k: int) -> str | None:
        """'enemy' (red) or 'ally' (teal) fill behind the victim's name, or None when no row is there."""
        b0, b1 = self.band(k)
        region = hsv[b0 + 5:b1 - 5, self.right - 130:self.right - 60]
        h, sat, val = region[..., 0], region[..., 1], region[..., 2]
        lit = (sat >= 55) & (val >= 110)
        red = (((h <= 10) | (h >= 170)) & lit).mean()
        teal = ((h >= 65) & (h <= 100) & lit).mean()
        if max(red, teal) < MIN_TEAM_FILL:
            return None
        return "enemy" if red > teal else "ally"

    def _self_boxes(self, hsv: np.ndarray, gray: np.ndarray) -> dict[int, set[str]]:
        """slot -> sides ('kill' = killer end, 'death' = victim end) holding a portrait-sized yellow box."""
        yellow = cv2.inRange(hsv, (20, 90, 150), (38, 255, 255))
        # The player's rows also carry a thin yellow outline that joins the box into one long component; opening
        # removes 1-2 px lines and keeps the box.
        yellow = cv2.morphologyEx(yellow, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        n, _, stats, _ = cv2.connectedComponentsWithStats(yellow, connectivity=8)
        sides: dict[int, set[str]] = {}
        for i in range(1, n):
            x, y, w, h, area = (int(v) for v in stats[i])
            # Portrait boxes span the row height; assist mini-portraits and stray blobs are ~18-24 px.
            if not MIN_BOX_H <= h <= ROW_H + 6:
                continue
            at_right = x + w >= self.right - 26
            # At the right end the victim box merges with the chevron outside it: wider and sparser than a bare box.
            max_w, min_fill = (72, 0.18) if at_right else (60, 0.30)
            if not (14 <= w <= max_w and area >= min_fill * w * h):
                continue
            slot = round((y + h / 2 + self.cy - ROW_Y0) / ROW_STEP)
            if not 0 <= slot < ROWS:
                continue
            b0, b1 = self.band(slot)
            if y < b0 - 4 or y + h > b1 + 4:  # Effect streaks cross the band; a portrait box stays inside it.
                continue
            if self._row_edge(gray, slot) < MIN_ROW_EDGE:  # Yellow scenery with no row behind it.
                continue
            sides.setdefault(slot, set()).add("death" if at_right else "kill")
        return sides

    def _chevrons(self, hsv: np.ndarray, gray: np.ndarray) -> dict[int, set[str]]:
        """slot -> sides with a yellow chevron outside the row end and the yellow outline running along the row."""
        yellow = cv2.inRange(hsv, (20, 90, 150), (38, 255, 255))
        n, _, stats, _ = cv2.connectedComponentsWithStats(yellow, connectivity=8)
        sides: dict[int, set[str]] = {}
        for i in range(1, n):
            x, y, w, h, area = (int(v) for v in stats[i])
            if not (5 <= w <= 12 and 14 <= h <= 22 and h >= 1.5 * w and area >= 0.25 * w * h):
                continue
            slot = round((y + h / 2 + self.cy - ROW_Y0) / ROW_STEP)
            if not 0 <= slot < ROWS:
                continue
            b0, b1 = self.band(slot)
            if y < b0 - 2 or y + h > b1 + 2 or self._row_edge(gray, slot) < MIN_CHEVRON_ROW_EDGE:
                continue
            side = "death" if x >= self.right - 4 else "kill"
            span = slice(max(0, x - 170), max(0, x - 2)) if side == "death" else slice(x + w + 2, x + w + 170)
            outline = max(int((yellow[max(0, b0 - 3):b0 + 3, span] > 0).any(axis=0).sum()),
                          int((yellow[b1 - 3:b1 + 3, span] > 0).any(axis=0).sum()))
            if outline >= MIN_OUTLINE:
                sides.setdefault(slot, set()).add(side)
        return sides

    def rows(self, feed: np.ndarray) -> list[FeedRow]:
        hsv = cv2.cvtColor(feed, cv2.COLOR_BGR2HSV)
        gray = cv2.cvtColor(feed, cv2.COLOR_BGR2GRAY).astype(np.float32)
        marks = self._self_boxes(hsv, gray)
        for k, s in self._chevrons(hsv, gray).items():
            marks.setdefault(k, set()).update(s)
        out = []
        for k, sides in sorted(marks.items()):
            team = self._victim_team(hsv, k)
            if team == "ally" and "death" in sides:
                kind = "death"
            elif team == "enemy" and sides == {"kill"}:
                kind = "kill"
            else:
                continue
            out.append(FeedRow(k, kind, self._signature(gray, k)))
        return out

    def _signature(self, gray: np.ndarray, k: int) -> np.ndarray:
        """Normalised thumbnail of the row's victim side; stable while the entry stays on screen and moves up."""
        b0, b1 = self.band(k)
        g = gray[b0 + 3:b1 - 3, self.right - 200:self.right - 4]
        v = cv2.resize(g, (48, 6), interpolation=cv2.INTER_AREA).ravel()
        v = v - v.mean()
        return v / (np.linalg.norm(v) + 1e-6)


class FeedTracker:
    """Turns per-frame self rows into kill/death events, one per kill-feed entry."""

    def __init__(self):
        self._seen: list[tuple[float, str, int, np.ndarray]] = []  # (last_t, type, slot, signature)
        self._last_death = -1e9
        self.events: list[Event] = []

    def feed(self, t: float, rows: Iterable[FeedRow]) -> list[Event]:
        self._seen = [s for s in self._seen if t - s[0] <= ENTRY_LIFE]
        new = []
        for row in rows:
            match = next((i for i, (lt, kind, slot, sig) in enumerate(self._seen) if kind == row.type and (
                float(sig @ row.signature) >= SAME_ENTRY or (slot in (row.slot, row.slot + 1) and t - lt <= FLICKER))), None)
            if match is not None:
                self._seen[match] = (t, row.type, row.slot, row.signature)
                continue
            self._seen.append((t, row.type, row.slot, row.signature))
            if row.type == "death":
                if t - self._last_death < DEATH_GAP:  # A death row that fades and returns looking different.
                    continue
                self._last_death = t
            # "Counted" means a kill of the player's; a death is shown but never counted (as derive marks it).
            kill = row.type == "kill"
            ev = Event(id=f"v{int(round(t * 1000))}", t=round(t, 3), type=row.type, score=1.0, damage_line=False,
                       name_sig=None, counted=kill, counted_reason="first" if kill else "death")
            self.events.append(ev)
            new.append(ev)
        return new


class ValorantLiveKills:
    """Live kill detection with the interface live.LiveEngine expects of its `kills` (feed/snapshot/finish/revision),
    plus rounds from the scoreboard and per-round multi-kill / ace events."""

    def __init__(self, profile: ValorantProfile):
        self.detector = FeedDetector(profile)
        self.tracker = FeedTracker()
        self.round_tracker = RoundTracker(profile.capture_spec[:2])
        self.revision = 0      # Bumped when an event or round is added, so snapshots are rebuilt only then.
        self.degraded: list[str] = []
        self.h_scale = 1.0

    @property
    def rounds(self) -> list[Round]:
        return self.round_tracker.rounds

    def feed(self, t: float, banner: np.ndarray, spec: np.ndarray) -> None:
        if self.tracker.feed(t, self.detector.rows(banner)):
            self.revision += 1
        if self.round_tracker.feed(t, spec) is not None:
            self.revision += 1

    def snapshot(self) -> tuple[list[Event], list]:
        events = self.tracker.events
        return sorted(events + round_highlights(events, self.rounds), key=lambda e: e.t), []

    def finish(self) -> tuple[list[Event], list]:
        return self.snapshot()


# ---- Recognising Valorant footage that carries no aditor_game tag (used by game_detect) ----

# The top scoreboard: translucent grey score boxes beside the timer, flanked by the ally (teal) and enemy (red) agent
# strips. A strip thins as players die and its translucent fill washes out over bright skies, so one strip suffices.
ALLY_STRIP = (712, 34, 56, 30)     # x, y, w, h on the 1920x1080 frame, just outside the ally score box
ENEMY_STRIP = (1140, 34, 56, 30)   # just outside the enemy score box
SCORE_BOX = (796, 36, 56, 26)      # the ally score box itself: grey behind a white digit


def scoreboard_visible(frame: np.ndarray) -> bool:
    """frame: BGR 1920x1080 (or at least the top 80 rows of it)."""
    hsv = cv2.cvtColor(frame[:80], cv2.COLOR_BGR2HSV)

    def share(box, ranges) -> float:
        x, y, w, h = box
        region = hsv[y:y + h, x:x + w]
        lit = (region[..., 1] >= 60) & (region[..., 2] >= 90)
        hue = region[..., 0]
        return float(sum((((hue >= lo) & (hue <= hi)) & lit).mean() for lo, hi in ranges))

    x, y, w, h = SCORE_BOX
    grey_box = float(hsv[y:y + h, x:x + w, 1].mean()) < 70
    strips = share(ALLY_STRIP, [(65, 100)]) >= 0.35 or share(ENEMY_STRIP, [(0, 10), (170, 180)]) >= 0.35
    return grey_box and strips


# ---- Offline analysis ----

def _make_doc(info: VideoInfo, profile: ValorantProfile, status: str, progress_t: float, events: list[Event],
              clips: list[Clip]) -> dict:
    return {
        "version": 1,
        "game": GAME,
        "video": info.to_dict(),
        "analysis": {"status": status, "progress_t": progress_t, "engine_version": ENGINE_VERSION,
                     "templates_version": profile.templates_version, "h_scale": 1.0, "aspect_squash": 1.0,
                     "aspect_source": "default"},
        "events": [e.to_dict() for e in events],
        "spectating": [],
        "clips": [c.to_dict() for c in clips],
    }


def _save(cp: Path, doc: dict, fallback: Path) -> None:
    doc["cache_path"] = str(cp)
    written = save_cache(cp, doc, fallback_dir=fallback)
    if written != cp:
        doc["cache_path"] = str(written)
        save_cache(written, doc)


def analyze_valorant(path: str, info: VideoInfo, profile: ValorantProfile, *, cache_dir: Path, beside: bool = False,
                     force: bool = False, on_progress: Callable[[float, float], None] = lambda t, d: None,
                     cancel: threading.Event | None = None, hwaccel: bool = True) -> dict:
    cache_dir = Path(cache_dir)
    cp = cache_path(path, cache_dir, beside)
    old = load_cache(cp)
    if not force and old is not None and not needs_reanalysis(old, info, profile.templates_version, 1.0, game=GAME):
        old["cache_path"] = str(cp)
        return old
    # Keep the user's edits (deletions, overrides, manual events and clips) across reanalysis, as for Apex.
    old_done = old is not None and (old.get("analysis") or {}).get("status") == "done"
    base_events = [Event.from_dict(e) for e in (old or {}).get("events", [])] if old_done else []
    clips = merge_clips([Clip.from_dict(c) for c in (old or {}).get("clips", [])], [])

    detector = FeedDetector(profile)
    tracker = FeedTracker()
    rounds = RoundTracker(profile.capture_spec[:2])
    # Software decoding: the player's yellow kill-feed marker is only faintly saturated in some clients, and hardware
    # decoding's slightly different chroma pushes it under the yellow threshold (a deathmatch recording lost 4 of 34
    # kills). Live detection is unaffected: aditorrec crops the captured RGB frames directly.
    stream = FrameStream(path, profile, hwaccel=False, codec=info.codec)
    last_report = -1.0
    for t, feed, spec in stream:
        if cancel is not None and cancel.is_set():
            stream.close()
            raise Cancelled()
        tracker.feed(t, detector.rows(feed))
        rounds.feed(t, spec)
        if t - last_report >= 1.0:
            on_progress(t, info.duration)
            last_report = t
    events = sorted(tracker.events + round_highlights(tracker.events, rounds.rounds), key=lambda e: e.t)
    unmatched: list[Event] = []
    if base_events:
        events, unmatched = merge_reanalysis(base_events, events)
    doc = _make_doc(info, profile, "done", info.duration, events, clips)
    doc["rounds"] = [r.to_dict() for r in rounds.rounds]
    try:
        doc["keyframes"] = keyframes(path)
    except Exception:  # noqa: BLE001 - keyframes only speed up export cuts; analysis stands without them.
        doc["keyframes"] = []
    doc["unmatched"] = [e.to_dict() for e in unmatched]
    _save(cp, doc, cache_dir)
    on_progress(info.duration, info.duration)
    return doc
