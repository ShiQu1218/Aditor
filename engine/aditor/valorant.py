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
import math
import threading
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Iterable

import cv2
import numpy as np

from . import ENGINE_VERSION
from .cache import cache_path, load_cache, merge_clips, merge_reanalysis, needs_reanalysis, save_cache
from .decode import FrameStream
from .errors import Cancelled
from .layout import BASE_H, BASE_W, REFERENCE_ASPECT, SUPPORTED_ASPECTS, Layout, LayoutError
from .models import Clip, Event, VideoInfo
from .probe import keyframes
from .valorant_rounds import Round, RoundTracker, round_highlights

GAME = "valorant"

# Detection constants on the 1920x1080 reference frame.
ROW_Y0, ROW_STEP, ROW_H, ROWS = 112, 40, 30, 6
RIGHT_EDGE = 1902
MIN_BOX_H = 28
# With the yellow outline along the row as well, a shorter box suffices: in some recordings (a 4:3 deathmatch) the box
# thresholds to 21-27 px, the range of other players' assist mini-portraits, which carry no outline.
MIN_OUTLINED_BOX_H = 18
MIN_OUTLINED_BOX_W = 19  # Assist mini-portraits are ~15 px wide; the player's box 21-25.
MIN_ROW_EDGE = 45.0
MIN_TEAM_FILL = 0.30
# Newer clients mark the player's row with a thin yellow outline along their half and a chevron outside the row end
# instead of a solid portrait box. The chevron is a narrow upright triangle (~9x19; assist mini-portraits are squarer)
# and the outline next to it shows a row is there, so a lower edge contrast suffices (overlays such as the performance
# graphs soften the row edges).
MIN_OUTLINE = 40
# Compressed footage can erode a player's portrait to 20-24 px and its outline to
# 36-39 columns. Accept that combination only with a dense portrait and the full
# row-edge contrast; keep the looser chevron/outlined-row path at 40 columns.
MIN_COMPACT_OUTLINE = 36
MIN_COMPACT_FILL = 0.60
MIN_PORTRAIT_FILL = 0.45  # Sparse yellow needs a saturated outline or a projecting chevron tip.
MIN_CHEVRON_ROW_EDGE = 25.0
KILL_CHEVRON_MIN_OFFSET = 200

# Tracking: one kill-feed entry may flicker while fading and moves up a slot when an older row expires.
SAME_ENTRY = 0.80   # Row signature correlation above which two sightings are the same entry.
ENTRY_LIFE = 7.0    # Seconds an entry can stay on screen.
FLICKER = 1.5       # Tolerated weak-row gap / sustained empty-feed interval.
DEATH_GAP = 6.0     # Minimum seconds between two deaths (Clove can revive and die again within a round).
BACKDATE_WINDOW = 3.0  # Keep actual sightings, never subtract a fixed delay from an event.
IDENTITY_MATCH = 0.65


class ValorantProfileError(Exception):
    pass


# Reference rects (1920x1080, 16:9) the detectors read: the kill feed hangs from the top right, the scoreboard sits at
# the top centre.
BANNER_REF = (1316, 84, 600, 256)
SPEC_REF = (740, 20, 460, 64)

# Valorant sizes its HUD by the screen height, so at a narrower render aspect the HUD keeps its pixel size inside a
# canvas 1080 * aspect wide. That canvas reaches the 1920x1080 frame either stretched (a 4:3 swap chain scaled to 16:9
# by the display, the capture or the decoder: x scales by 16:9 / aspect) or letterboxed (black side bars, the canvas
# centred at its own size). Black bars show which one a frame is, so the game's letterbox setting is not needed.
LETTERBOX_DARK = 12  # Mean grey level of a black bar (encoded black lands a few levels above 0).
LETTERBOX_PEAK = 40  # Brightest pixel a black bar may hold.


def _canvas_width(aspect: float) -> float:
    return BASE_H * aspect


def _source_x(x: float, anchor: str, aspect: float, letterbox: bool) -> float:
    """Where reference x (anchored right or centre) lands in the 1920x1080 frame of a game rendered at `aspect`."""
    if letterbox:
        return (BASE_W + _canvas_width(aspect)) / 2 - (BASE_W - x) if anchor == "right" else x
    k = REFERENCE_ASPECT / aspect
    return BASE_W - (BASE_W - x) * k if anchor == "right" else BASE_W / 2 + (x - BASE_W / 2) * k


def _source_span(rect, anchor: str, aspect: float, letterbox: bool) -> tuple[float, float]:
    x, _, w, _ = rect
    return _source_x(x, anchor, aspect, letterbox), _source_x(x + w, anchor, aspect, letterbox)


def capture_rect(rect, anchor: str) -> tuple[int, int, int, int]:
    """Smallest rect holding `rect`'s content at every supported aspect, stretched or letterboxed."""
    spans = [_source_span(rect, anchor, a, lb) for a in SUPPORTED_ASPECTS.values() for lb in (False, True)]
    x0 = math.floor(min(s[0] for s in spans))
    x1 = math.ceil(max(s[1] for s in spans))
    return (x0, rect[1], x1 - x0, rect[3])


@dataclass(frozen=True)
class ValorantProfile:
    """Crop rects in the shape FrameStream expects of a Profile. The capture rects cover every aspect; restore() cuts
    the reference rects back out of them for the render aspect in `layout`."""
    templates_version: str
    capture_banner: tuple[int, int, int, int]
    capture_spec: tuple[int, int, int, int]
    dir: Path = field(default_factory=Path)
    layout: Layout = Layout(1.0)

    @property
    def origin(self) -> tuple[int, int]:
        return BANNER_REF[0], BANNER_REF[1]

    @property
    def spec_origin(self) -> tuple[int, int]:
        return SPEC_REF[0], SPEC_REF[1]

    @property
    def aspect(self) -> float:
        return self.layout.squash * REFERENCE_ASPECT

    def with_layout(self, layout: Layout) -> "ValorantProfile":
        return replace(self, layout=layout)

    def letterboxed(self, banner: np.ndarray) -> bool:
        """Whether the banner crop is black where a letterboxed frame has its right bar."""
        if self.layout.identity:
            return False
        bar = int((BASE_W + _canvas_width(self.aspect)) / 2) + 4 - self.capture_banner[0]
        region = banner[:, bar:self.capture_banner[2] - 4]
        return region.size > 0 and float(region.mean()) < LETTERBOX_DARK and int(region.max()) < LETTERBOX_PEAK

    def _cut(self, img: np.ndarray, capture, rect, anchor: str, letterbox: bool) -> np.ndarray:
        x0, x1 = _source_span(rect, anchor, self.aspect, letterbox)
        a, b = round(x0) - capture[0], round(x1) - capture[0]
        if a < 0 or b > img.shape[1]:
            raise LayoutError(f"Capture rect {capture} does not contain {rect} at aspect {self.aspect:.3f}")
        part = img[:, a:b]
        return part if part.shape[1] == rect[2] else cv2.resize(part, (rect[2], rect[3]), interpolation=cv2.INTER_AREA)

    def restore(self, banner: np.ndarray, spec: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        letterbox = self.letterboxed(banner)
        return (self._cut(banner, self.capture_banner, BANNER_REF, "right", letterbox),
                self._cut(spec, self.capture_spec, SPEC_REF, "centre", letterbox))


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
    want = capture_rect(BANNER_REF, "right"), capture_rect(SPEC_REF, "centre")
    if (banner, spec) != want:
        raise ValorantProfileError(f"capture_rois {banner}/{spec} must be {want[0]}/{want[1]} (the reference rects at "
                                   "every aspect)")
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
    confirmed: bool = True  # Weak team-colored rows may be tracked but never create an event alone.
    identity: np.ndarray | None = None


def _pale_yellow(hsv: np.ndarray) -> np.ndarray:
    """The thin outline washes out over bright scenery (saturation ~70); tan walls stay below hue 26."""
    return cv2.inRange(hsv, (26, 55, 140), (40, 255, 255))


def _projecting_tip(component: np.ndarray, side: str) -> bool:
    """A chevron's tip projects beyond both wings; a vertical stripe does not."""
    h, w = component.shape
    boundary = np.array([float(points.min() if side == "kill" else w - 1 - points.max())
                         if (points := np.flatnonzero(line)).size else float(w) for line in component])
    wing = min(float(np.median(boundary[:h // 4])), float(np.median(boundary[-h // 4:])))
    return wing - float(boundary[h // 4:3 * h // 4].min()) >= 3


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
        raw = cv2.inRange(hsv, (20, 90, 150), (38, 255, 255))
        outline = raw | _pale_yellow(hsv)
        # The player's rows also carry a thin yellow outline that joins the box into one long component; opening
        # removes 1-2 px lines and keeps the box.
        yellow = cv2.morphologyEx(raw, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        n, labels, stats, _ = cv2.connectedComponentsWithStats(yellow, connectivity=8)
        sides: dict[int, set[str]] = {}
        for i in range(1, n):
            x, y, w, h, area = (int(v) for v in stats[i])
            # Portrait boxes span the row height; assist mini-portraits and stray blobs are ~18-24 px.
            if not MIN_OUTLINED_BOX_H <= h <= ROW_H + 6:
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
            side = "death" if at_right else "kill"
            if side == "kill" and x > self.right - KILL_CHEVRON_MIN_OFFSET:
                continue  # A victim portrait/weapon highlight is not the killer's player marker.
            outline_columns = self._outline(outline, slot, x, x + w, side)
            if (side == "kill" and area < MIN_PORTRAIT_FILL * w * h
                    and self._outline(raw, slot, x, x + w, side) < MIN_OUTLINE
                    and not _projecting_tip(labels[y:y + h, x:x + w] == i, side)):
                continue  # Yellow clothes plus pale scenery can mimic a portrait-sized component.
            outlined = outline_columns >= MIN_OUTLINE
            edge = self._row_edge(gray, slot)
            compact = (w >= MIN_OUTLINED_BOX_W and outline_columns >= MIN_COMPACT_OUTLINE
                       and area >= MIN_COMPACT_FILL * w * h and edge >= MIN_ROW_EDGE)
            # Yellow scenery with no row behind it has no crisp row edges; the outline already shows a row is there.
            if edge < (MIN_CHEVRON_ROW_EDGE if outlined else MIN_ROW_EDGE):
                continue
            if h < MIN_BOX_H and (not (outlined or compact) or w < MIN_OUTLINED_BOX_W):
                continue
            sides.setdefault(slot, set()).add(side)
        return sides

    def _chevrons(self, hsv: np.ndarray, gray: np.ndarray, *, faint: bool = False) -> dict[int, set[str]]:
        """slot -> sides with a yellow chevron outside the row end and the yellow outline running along the row."""
        yellow = _pale_yellow(hsv) if faint else cv2.inRange(hsv, (20, 90, 150), (38, 255, 255))
        n, labels, stats, _ = cv2.connectedComponentsWithStats(yellow, connectivity=8)
        sides: dict[int, set[str]] = {}
        for i in range(1, n):
            x, y, w, h, area = (int(v) for v in stats[i])
            max_w, max_h, fill = (14, 26, 0.40) if faint else (12, 22, 0.25)
            if not (5 <= w <= max_w and 14 <= h <= max_h and h >= 1.5 * w and area >= fill * w * h):
                continue
            slot = round((y + h / 2 + self.cy - ROW_Y0) / ROW_STEP)
            if not 0 <= slot < ROWS:
                continue
            b0, b1 = self.band(slot)
            if y < b0 - 2 or y + h > b1 + 2 or self._row_edge(gray, slot) < MIN_CHEVRON_ROW_EDGE:
                continue
            side = "death" if x >= self.right - 4 else "kill"
            if faint:
                # The tip must project beyond BOTH wings. Thin vertical clothes
                # and scenery fragments otherwise look like a pale chevron.
                if not _projecting_tip(labels[y:y + h, x:x + w] == i, side):
                    continue
            # A kill chevron sits outside the row's left end, far from the right edge; one in between belongs to a
            # death row still sliding in.
            if side == "kill" and x > self.right - KILL_CHEVRON_MIN_OFFSET:
                continue
            # The player's own half of the row (teal, washed out over bright scenery) follows the chevron, past their
            # portrait; scenery that merely looks like a chevron has none.
            near = slice(x + w + 40, x + w + 140) if side == "kill" else slice(max(0, x - 140), max(0, x - 40))
            region = hsv[b0 + 5:b1 - 5, near]
            pale_teal = (region[..., 0] >= 55) & (region[..., 0] <= 100) & (region[..., 1] >= 25) & (region[..., 2] >= 110)
            if not region.size or pale_teal.mean() < (0.15 if faint else MIN_TEAM_FILL):
                continue
            if self._outline(yellow, slot, x, x + w, side) >= MIN_OUTLINE:
                sides.setdefault(slot, set()).add(side)
        return sides

    def _outline(self, outline: np.ndarray, k: int, x0: int, x1: int, side: str) -> int:
        """Columns of yellow outline along the row's top or bottom edge, running from a mark at x0..x1 into the row.
        The line can sit a few pixels outside the band (rows drawn slightly taller)."""
        b0, b1 = self.band(k)
        span = slice(max(0, x0 - 170), max(0, x0 - 2)) if side == "death" else slice(x1 + 2, x1 + 170)
        return max(int((outline[max(0, b0 - 6):b0 + 3, span] > 0).any(axis=0).sum()),
                   int((outline[b1 - 3:b1 + 5, span] > 0).any(axis=0).sum()))

    def observations(self, feed: np.ndarray) -> list[FeedRow]:
        """Track visible feed rows before the player's marker becomes readable.

        A later confirmed self marker can validate that same row's earlier sightings.
        Other players' rows remain unconfirmed and never count as kills/deaths.
        """
        hsv = cv2.cvtColor(feed, cv2.COLOR_BGR2HSV)
        gray = cv2.cvtColor(feed, cv2.COLOR_BGR2GRAY).astype(np.float32)
        marks = self._self_boxes(hsv, gray)
        for faint in (False, True):
            for k, s in self._chevrons(hsv, gray, faint=faint).items():
                marks.setdefault(k, set()).update(s)
        out = []
        for k in range(ROWS):
            sides = marks.get(k, set())
            team = self._victim_team(hsv, k)
            if team == "ally" and "death" in sides:
                kind = "death"
            elif team == "enemy" and sides == {"kill"}:
                kind = "kill"
            else:
                if team is None or self._row_edge(gray, k) < MIN_ROW_EDGE:
                    continue
                kind = "kill" if team == "enemy" else "death"
                out.append(FeedRow(k, kind, self._signature(gray, k), False, self._identity(hsv, k)))
                continue
            out.append(FeedRow(k, kind, self._signature(gray, k), True, self._identity(hsv, k)))
        return out

    def rows(self, feed: np.ndarray) -> list[FeedRow]:
        """Confirmed self rows; retained for callers inspecting one frame only."""
        return [row for row in self.observations(feed) if row.confirmed]

    def _identity(self, hsv: np.ndarray, k: int) -> np.ndarray | None:
        """Victim-name glyphs, less affected by the translucent colored background."""
        b0, b1 = self.band(k)
        region = hsv[b0 + 5:b1 - 5, self.right - 146:self.right - 36]
        white = cv2.inRange(region, (0, 0, 175), (180, 100, 255))
        if np.count_nonzero(white) < 25 or np.count_nonzero(white) > white.size * 0.6:
            return None
        v = cv2.resize(white, (64, 12), interpolation=cv2.INTER_AREA).astype(np.float32).ravel()
        return v / (np.linalg.norm(v) + 1e-6)

    def _signature(self, gray: np.ndarray, k: int) -> np.ndarray:
        """Normalised thumbnail of the row's victim side; stable while the entry stays on screen and moves up."""
        b0, b1 = self.band(k)
        g = gray[b0 + 3:b1 - 3, self.right - 200:self.right - 4]
        v = cv2.resize(g, (48, 6), interpolation=cv2.INTER_AREA).ravel()
        v = v - v.mean()
        return v / (np.linalg.norm(v) + 1e-6)


@dataclass
class _FeedTrack:
    first_t: float
    last_t: float
    row: FeedRow
    anchor: FeedRow
    sightings: list[float]
    event: Event | None = None
    strong_hits: int = 0
    defer: bool = False
    missing_since: float | None = None


class FeedTracker:
    """Turns per-frame self rows into kill/death events, one per kill-feed entry."""

    def __init__(self):
        self._seen: list[_FeedTrack] = []
        self._last_death = -1e9
        self.events: list[Event] = []

    def _new_id(self, t: float) -> str:
        """Two entries can appear in the same frame; ids must stay unique (autoclip maps events by id)."""
        base = f"v{int(round(t * 1000))}"
        taken = {e.id for e in self.events}
        n = 1
        ident = base
        while ident in taken:
            ident = f"{base}-{n}"
            n += 1
        return ident

    def feed(self, t: float, rows: Iterable[FeedRow]) -> list[Event]:
        # An entry leaves the feed a few seconds after it appears, so the same victim killed again later is a new entry
        # even if it looks alike.
        self._seen = [s for s in self._seen if t - s.first_t <= ENTRY_LIFE
                      and (s.missing_since is None or t - s.missing_since <= FLICKER)
                      and (s.event is not None or t - s.last_t <= FLICKER)]
        rows = list(rows)
        # Compare appearance AND plausible motion. Entries only move upward; a new
        # row below an old row is not its flicker, even if the victim looks alike.
        edges = []
        for j, row in enumerate(rows):
            for i, track in enumerate(self._seen):
                if track.row.type != row.type or row.slot > track.row.slot:
                    continue
                raw = max(float(track.row.signature @ row.signature), float(track.anchor.signature @ row.signature))
                identities = [r.identity for r in (track.row, track.anchor) if r.identity is not None]
                if row.identity is not None and identities:
                    identity = max(float(v @ row.identity) for v in identities)
                    score, threshold = 0.35 * raw + 0.65 * identity, IDENTITY_MATCH
                else:
                    score, threshold = raw, SAME_ENTRY
                    # A recently seen confirmed entry moving up is stronger evidence
                    # than an unconfirmed copy when compression erases its glyphs.
                    if track.event is not None and row.slot < track.row.slot and t - track.last_t <= FLICKER:
                        threshold = 0.72
                if score >= threshold:
                    edges.append((track.event is not None, score, j, i))
        assigned: dict[int, int] = {}
        taken: set[int] = set()
        for _, _, j, i in sorted(edges, reverse=True):
            if j not in assigned and i not in taken:
                assigned[j] = i
                taken.add(i)
        new = []
        for j, row in sorted(enumerate(rows), key=lambda item: item[1].slot):
            if j in assigned:
                track = self._seen[assigned[j]]
                if track.event is None and t - track.last_t > 0.5:
                    track.sightings.clear()
                    track.strong_hits = 0
                track.last_t, track.row = t, row
                track.missing_since = None
                track.sightings.append(t)
                track.sightings = [seen for seen in track.sightings if t - seen <= BACKDATE_WINDOW]
            else:
                # A transient copy immediately above a still-visible entry should
                # not count as a new kill. Require a second strong sighting there.
                above_known = any(rows[other].type == row.type and rows[other].slot == row.slot + 1
                                  for other in assigned)
                replaced_known = any(s.event is not None and s.row.type == row.type
                                     and s.row.slot == row.slot and t - s.last_t <= FLICKER
                                     for s in self._seen)
                track = _FeedTrack(t, t, row, row, [t], defer=above_known or replaced_known)
                self._seen.append(track)
            if not row.confirmed or track.event is not None:
                continue
            track.strong_hits += 1
            if track.defer and track.strong_hits < 2:
                continue
            # Backdate only a row whose identity was actually observed earlier.
            # One weak flash is insufficient evidence for an earlier timestamp.
            event_t = track.sightings[0] if len(track.sightings) >= 2 else t
            if row.type == "death" and event_t - self._last_death < DEATH_GAP:
                continue
            if row.type == "death":
                self._last_death = event_t
            # "Counted" means a kill of the player's; a death is shown but never counted (as derive marks it).
            kill = row.type == "kill"
            ev = Event(id=self._new_id(event_t), t=round(event_t, 3), type=row.type, score=1.0, damage_line=False,
                       name_sig=None, counted=kill, counted_reason="first" if kill else "death")
            self.events.append(ev)
            track.event = ev
            track.anchor = row
            new.append(ev)
        # A sustained empty feed ends old entries, including confirmed ones. A
        # missing single row may instead be unreadable or sliding among other rows.
        for track in self._seen:
            if rows:
                track.missing_since = None
            elif track.missing_since is None:
                track.missing_since = t
        return new


class ValorantLiveKills:
    """Live kill detection with the interface live.LiveEngine expects of its `kills` (feed/snapshot/finish/revision),
    plus rounds from the scoreboard and per-round multi-kill / ace events."""

    def __init__(self, profile: ValorantProfile):
        self.detector = FeedDetector(profile)
        self.tracker = FeedTracker()
        self.round_tracker = RoundTracker(profile.spec_origin)
        self.revision = 0      # Bumped when an event or round is added, so snapshots are rebuilt only then.
        self.degraded: list[str] = []
        self.h_scale = 1.0

    @property
    def rounds(self) -> list[Round]:
        return self.round_tracker.rounds

    def feed(self, t: float, banner: np.ndarray, spec: np.ndarray) -> None:
        if self.tracker.feed(t, self.detector.observations(banner)):
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

HIGHLIGHT_TYPES = ("multikill", "ace")


def merge_events(base: list[Event], detected: list[Event], rounds: list[Round]) -> tuple[list[Event], list[Event]]:
    """Carry the user's kill/death edits onto the new detections first, so multi-kills follow kills they deleted or
    added; then carry their edits on the highlights themselves. Returns (events, old edits that matched nothing)."""
    is_auto_highlight = lambda e: e.type in HIGHLIGHT_TYPES and e.source != "manual"  # noqa: E731
    events, unmatched = merge_reanalysis([e for e in base if not is_auto_highlight(e)], detected)
    highlights, lost = merge_reanalysis([e for e in base if is_auto_highlight(e)], round_highlights(events, rounds))
    return sorted(events + highlights, key=lambda e: e.t), unmatched + lost


def _make_doc(info: VideoInfo, profile: ValorantProfile, status: str, progress_t: float, events: list[Event],
              clips: list[Clip], aspect_source: str) -> dict:
    return {
        "version": 1,
        "game": GAME,
        "video": info.to_dict(),
        "analysis": {"status": status, "progress_t": progress_t, "engine_version": ENGINE_VERSION,
                     "templates_version": profile.templates_version, "h_scale": 1.0,
                     "aspect_squash": profile.layout.squash, "aspect_source": aspect_source},
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
                     cancel: threading.Event | None = None, hwaccel: bool = True, aspect_source: str = "default") -> dict:
    cache_dir = Path(cache_dir)
    cp = cache_path(path, cache_dir, beside)
    old = load_cache(cp)
    if not force and old is not None and not needs_reanalysis(old, info, profile.templates_version, profile.layout.squash,
                                                    game=GAME):
        old["cache_path"] = str(cp)
        return old
    # Keep the user's edits (deletions, overrides, manual events and clips) across reanalysis, as for Apex.
    old_done = old is not None and (old.get("analysis") or {}).get("status") == "done"
    base_events = [Event.from_dict(e) for e in (old or {}).get("events", [])] if old_done else []
    clips = merge_clips([Clip.from_dict(c) for c in (old or {}).get("clips", [])], [])

    detector = FeedDetector(profile)
    tracker = FeedTracker()
    rounds = RoundTracker(profile.spec_origin)
    # Software decoding: the player's yellow kill-feed marker is only faintly saturated in some clients, and hardware
    # decoding's slightly different chroma pushes it under the yellow threshold (a deathmatch recording lost 4 of 34
    # kills). Live detection is unaffected: aditorrec crops the captured RGB frames directly.
    stream = FrameStream(path, profile, hwaccel=False, codec=info.codec)
    last_report = -1.0
    for t, feed, spec in stream:
        if cancel is not None and cancel.is_set():
            stream.close()
            raise Cancelled()
        tracker.feed(t, detector.observations(feed))
        rounds.feed(t, spec)
        if t - last_report >= 1.0:
            on_progress(t, info.duration)
            last_report = t
    events, unmatched = merge_events(base_events, tracker.events, rounds.rounds)
    doc = _make_doc(info, profile, "done", info.duration, events, clips, aspect_source)
    doc["rounds"] = [r.to_dict() for r in rounds.rounds]
    try:
        doc["keyframes"] = keyframes(path)
    except Exception:  # noqa: BLE001 - keyframes only speed up export cuts; analysis stands without them.
        doc["keyframes"] = []
    doc["unmatched"] = [e.to_dict() for e in unmatched]
    _save(cp, doc, cache_dir)
    on_progress(info.duration, info.duration)
    return doc
