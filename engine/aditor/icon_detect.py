"""Language-independent, icon-first per-frame kill-banner detection (the only event-detection path; see detect.Detector for the higher-level interface).

Language-independent icons on the banner (templates are in templates/icons/, cropped and averaged only from the English.mkv/Japanese.mkv training clips):
- chev   : three-layer chevron to the right of the score (left half of the "+N" score icon; present on all score banners, including REVIVE/CRATE REVEAL/enemy squad wipe)
- person: solo icon to the right of the chevron (personal kill score: knock, assist-knock, enemy squad wipe)
- group : three-person icon to the right of the chevron (squad score: squad wipe, REVIVE, CRATE REVEAL, etc.)
- skull : left of the first line = solo kill; also appears on the second line of squad-wipe banners
- hand  : left of the first line = assist elimination; also appears on the second line of squad-wipe banners (a teammate's assist kill)

Two additional language-independent layout cues are used:
- line2_ink : whether a second text line appears below the first (knock damage line or squad-wipe roster), measured by the ratio of white top-hat (thin bright-stroke) pixels
- name_color: whether the first line contains enemy-colored (red/yellow/pink) text; enemy names in knocks and solo kills use this color, while assists and non-event banners use white text

Emit an IconFrame (features and classification) for each frame. Event aggregation (grouping consecutive frames and splitting names) is handled by events.EventTracker. Classification rules and thresholds are in IconParams;
for training-data sources, acceptance results, and known failure modes, see the experiment report at .superpowers/sdd/icon-detect-report.md.
The product only needs knock and assist (assist_knock + assist_elim); elim/squad_wipe are used only as negative examples.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path

import cv2
import numpy as np

ICON_NAMES = ("chev", "person", "group", "skull", "hand", "plus")
ROW0, ROW1 = 30, 150          # Search band in banner coordinates, covering first-line y≈60–110 and the second line.
DEFAULT_SCALES = (0.9, 0.95, 1.0, 1.05, 1.1)


@dataclass
class IconParams:
    """Classification thresholds; defaults are measured from English.mkv/Japanese.mkv/SC1.mkv training clips, with no tuning on acceptance clips."""
    chev_min: float = 0.75       # Chevron score threshold.
    plus_min: float = 0.70       # "+" threshold to the left of the chevron (rejects lobby squad-card score icons without a plus sign).
    fig_min: float = 0.60        # Minimum score for solo/group icons.
    fig_lead: float = 0.10       # Minimum score difference between solo and group icons required to classify.
    left_min: float = 0.85       # First-line skull/hand threshold.
    line2_icon_min: float = 0.65  # Second-line skull/hand threshold (squad-wipe roster).
    line2_ink_min: float = 0.05  # Second-line thin-stroke ratio threshold after background-reference subtraction.
    name_color_min: int = 60     # First-line enemy-color pixel threshold after background-reference subtraction.
    left_above_max: float = 0.70  # If an arrow appears on the line above the left icon (>= this score), the icon belongs to the second line.


@dataclass
class IconFrame:
    kind: str | None = None          # knock / assist_knock / elim / assist_elim / squad_wipe / score_other / None
    chev: float = 0.0
    chev_x: int = 0
    chev_y: int = 0
    chev_scale: float = 1.0
    plus: float = 0.0                # "+" to the left of the chevron (before the score digits).
    person: float = 0.0
    group: float = 0.0
    skull: float = 0.0               # Best skull score on the first line (or the full band when no chevron is present).
    skull_x: int = 0
    skull_y: int = 0
    hand: float = 0.0
    hand_x: int = 0
    hand_y: int = 0
    left_above: float = 0.0          # Chevron score on the line above the left icon (to determine whether it is on the second line).
    line2_icons: int = 0             # Number of skull/hand matches on the line below the chevron.
    line2_ink: float = 0.0
    name_color: int = 0
    line2_ink_bg: float = 0.0        # Thin-stroke ratio in the background reference band (just above the first line).
    plus_x: int = 0                  # Left edge of the "+" sign in banner coordinates; right edge of the name.
    line_l: int = 0                  # Left edge of the first line in banner coordinates, inferred symmetrically from the chevron's right edge.
    row_h: int = 0                   # Height of the chevron (same as the first text line).
    name_color_bg: int = 0           # Enemy-color pixel count in the background reference band, normalized to the first-line height.

    def to_dict(self) -> dict:
        return asdict(self)


def _read_gray(path: Path) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f"Could not decode icon template: {path}")
    return img


def _rs(t: np.ndarray, s: float) -> np.ndarray:
    if abs(s - 1.0) < 1e-6:
        return t
    return cv2.resize(t, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)


def enemy_color_mask(bgr: np.ndarray) -> np.ndarray:
    """Language-independent mask for enemy-name colors (red/yellow/pink across the three color-blind modes). Values match red (including yellow/pink) in templates/*/profile.json."""
    b, g, r = (bgr[..., i].astype(np.int16) for i in range(3))
    red = (r >= 185) & (g <= 185) & (b <= 185) & (r - np.maximum(g, b) >= 50)
    yellow = (r >= 160) & (g >= 150) & (b <= 110) & (r - b >= 90) & (np.abs(r - g) <= 30)
    pink = (r >= 170) & (g >= 100) & (r - g >= 40) & (b - g >= -12) & (r - b >= 20)
    return red | yellow | pink


def is_knock(f: IconFrame, p: IconParams) -> bool:
    """Whether a solo-score banner is a knock: the first line has an enemy-colored name or a second (damage) line exists; both use net values after subtracting the background reference band."""
    return (f.name_color - f.name_color_bg >= p.name_color_min
            or f.line2_ink - f.line2_ink_bg >= p.line2_ink_min)


class IconDetector:
    def __init__(self, tpl_dir: Path, scales=DEFAULT_SCALES, params: IconParams | None = None,
                 diag: bool = False):
        """With diag=True, also compute left-icon features when a chevron is present (for offline threshold analysis; slower but does not change classification)."""
        self.scales = tuple(scales)
        self.p = params or IconParams()
        self.diag = diag
        base = {k: _read_gray(Path(tpl_dir) / f"{k}.png") for k in ICON_NAMES}
        self.base = base
        self.tpl = {k: {s: _rs(t, s) for s in self.scales} for k, t in base.items()}
        self._k = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))

    # ---- Matching ----
    def _best(self, g: np.ndarray, key: str, scales=None) -> tuple[float, int, int, float]:
        out = (0.0, 0, 0, (scales or self.scales)[0])
        for s in scales or self.scales:
            t = self.tpl[key][s]
            if g.shape[0] < t.shape[0] or g.shape[1] < t.shape[1]:
                continue
            r = cv2.matchTemplate(g, t, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(r)
            if np.isfinite(mx) and mx > out[0]:
                out = (float(mx), int(loc[0]), int(loc[1]), s)
        return out

    def _peaks(self, g: np.ndarray, key: str, s: float, thr: float) -> int:
        """Count key-icon matches in g (at scale s) above thr, using non-maximum suppression so each icon width counts once."""
        t = self.tpl[key][s]
        if g.shape[0] < t.shape[0] or g.shape[1] < t.shape[1]:
            return 0
        r = cv2.matchTemplate(g, t, cv2.TM_CCOEFF_NORMED)
        col = np.nan_to_num(r).max(axis=0)
        n, x, w = 0, 0, t.shape[1]
        while x < col.size:
            if col[x] >= thr:
                n += 1
                x += w
            else:
                x += 1
        return n

    def _score_features(self, g: np.ndarray) -> IconFrame:
        """Match the chevron and plus sign only, so scale calibration does not need to compute other classification features."""
        f = IconFrame()
        cs, cx, cy, sc = self._best(g, "chev")
        f.chev, f.chev_x, f.chev_y, f.chev_scale = cs, cx, cy + ROW0, sc
        ch = self.tpl["chev"][sc].shape
        if cs >= self.p.chev_min:
            near = tuple(s for s in self.scales if abs(s - sc) <= 0.051)
            # Plus sign in "+N": 15–110 px left of the chevron, on the same line (one to four digits).
            px0 = max(0, cx - int(110 * sc))
            f.plus, plx, _, _ = self._best(
                g[max(0, cy - 4):cy + ch[0] + 4, px0:max(px0 + 1, cx - int(12 * sc))], "plus", near)
            f.plus_x = px0 + plx
            f.row_h = ch[0]
        return f

    # ---- Public API ----
    def score_features(self, banner_bgr: np.ndarray) -> IconFrame:
        """Compute only chevron and plus features needed for scale calibration; do not classify the banner."""
        g = cv2.cvtColor(np.ascontiguousarray(banner_bgr[ROW0:ROW1]), cv2.COLOR_BGR2GRAY)
        return self._score_features(g)

    def features(self, banner_bgr: np.ndarray) -> IconFrame:
        p = self.p
        band = np.ascontiguousarray(banner_bgr[ROW0:ROW1])
        g = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
        f = self._score_features(g)
        cs, cx, cy, sc = f.chev, f.chev_x, f.chev_y - ROW0, f.chev_scale
        ch = self.tpl["chev"][sc].shape
        if cs >= p.chev_min:
            # Right of the chevron: solo/group icons (at a nearby scale).
            near = tuple(s for s in self.scales if abs(s - sc) <= 0.051)
            x0, y0 = cx + ch[1] - 6, max(0, cy - 8)
            sub = g[y0:y0 + ch[0] + 16, x0:x0 + int(48 * sc)]
            f.person = self._best(sub, "person", near)[0]
            f.group = self._best(sub, "group", near)[0]
            # Below the chevron: skull/hand count in a squad-wipe roster and the second-line thin-stroke ratio.
            l2y0, l2y1 = cy + int(0.75 * ch[0]), min(g.shape[0], cy + int(2.1 * ch[0]))
            l2 = g[l2y0:l2y1]
            s_icon = min(self.scales, key=lambda s: abs(s - sc))
            f.line2_icons = self._peaks(l2, "skull", s_icon, p.line2_icon_min) + \
                self._peaks(l2, "hand", s_icon, p.line2_icon_min)
            # The full banner is centered (banner center x=400): the first line's right edge is approximately the figure's right edge R,
            # and its left edge is approximately 800-R. The second (damage) line is also centered but shorter, so inspect only
            # the center [400-w/4, 400+w/4] (w = first-line width) to reduce background interference.
            R = min(g.shape[1], cx + ch[1] + int(24 * sc))
            L = max(0, g.shape[1] - R)
            f.line_l = L
            q = max(20, (R - L) // 4)
            xa, xb = max(0, 400 - q), min(g.shape[1], 400 + q)
            th = cv2.morphologyEx(l2, cv2.MORPH_TOPHAT, self._k)[:, xa:xb]
            f.line2_ink = float((th >= 60).mean()) if th.size else 0.0
            # Enemy-color pixels on the first line (same row as the chevron, from the first-line left edge to the chevron's left edge).
            row = band[max(0, cy - 2):cy + ch[0] + 2, L:max(L, cx - 4)]
            f.name_color = int(enemy_color_mask(row).sum())
            # Background reference band: just above the first line, with the same height (the banner plate covers only text rows; the area above is background).
            # Grass/yellow scenery increases both enemy-color and thin-stroke counts in the line and reference band, so classify using the difference.
            Y = cy + ROW0
            ry1 = max(0, Y - 4)
            ry0 = max(0, ry1 - (ch[0] + 4))
            ref = banner_bgr[ry0:ry1, L:max(L, cx - 4)]
            f.name_color_bg = int(enemy_color_mask(ref).sum() * (row.shape[0] / max(1, ref.shape[0]))) if ref.size else 0
            rg = cv2.cvtColor(np.ascontiguousarray(banner_bgr[max(0, ry1 - (l2y1 - l2y0)):ry1]), cv2.COLOR_BGR2GRAY)
            rth = cv2.morphologyEx(rg, cv2.MORPH_TOPHAT, self._k)[:, xa:xb] if rg.size else rg
            f.line2_ink_bg = float((rth >= 60).mean()) if rth.size else 0.0
            if not self.diag:
                f.kind = self.classify(f)
                return f
        # No score chevron: search the full band for a skull/hand to the left of the first line.
        ss, sx, sy, sk_s = self._best(g, "skull")
        hs, hx, hy, hd_s = self._best(g, "hand")
        f.skull, f.skull_x, f.skull_y = ss, sx, sy + ROW0
        f.hand, f.hand_x, f.hand_y = hs, hx, hy + ROW0
        if max(ss, hs) >= p.left_min:
            # Enemy-colored pixels to the right of the icon on the same line, and whether a chevron is on the line above (meaning this is a squad-wipe second-line roster icon).
            lx, ly, lsc, key = (sx, sy, sk_s, "skull") if ss >= hs else (hx, hy, hd_s, "hand")
            th_ = self.tpl[key][lsc].shape
            row = band[max(0, ly - 2):ly + th_[0] + 2, lx + th_[1]:lx + th_[1] + 320]
            if not (self.diag and cs >= p.chev_min):
                f.name_color = int(enemy_color_mask(row).sum())
            above = g[max(0, ly - 2 * th_[0] - 6):max(0, ly - 4), max(0, lx - 100):lx + 500]
            if above.shape[0] >= self.tpl["chev"][min(self.scales)].shape[0]:
                f.left_above = self._best(above, "chev")[0]
        f.kind = self.classify(f)
        return f

    def classify(self, f: IconFrame) -> str | None:
        """Classify using icons and layout cues. score_other means a score icon that is not a kill (group icons such as REVIVE or CRATE REVEAL)."""
        p = self.p
        if f.chev >= p.chev_min:
            if f.plus < p.plus_min:
                return None
            fig = None
            if max(f.person, f.group) >= p.fig_min and abs(f.person - f.group) >= p.fig_lead:
                fig = "person" if f.person > f.group else "group"
            if fig == "group":  # Squad score: squad wipe (roster icon on the second line) or REVIVE/CRATE REVEAL, etc.
                return "squad_wipe" if f.line2_icons >= 1 else "score_other"
            if fig == "person":  # Personal kill score: knock (enemy-colored name or damage line) / assist-knock (white text, one line).
                return "knock" if is_knock(f, p) else "assist_knock"
            return "squad_wipe" if f.line2_icons >= 1 else None
        left = max(f.skull, f.hand)
        if left >= p.left_min and f.left_above < p.left_above_max:
            return "elim" if f.skull >= f.hand else "assist_elim"
        return None

    def chev_best(self, banner_bgr: np.ndarray) -> tuple[float, float]:
        """Return the best (score, scale) for the chevron in the full banner band; used for calibration (fast: matches one chevron template only)."""
        g = cv2.cvtColor(np.ascontiguousarray(banner_bgr[ROW0:ROW1]), cv2.COLOR_BGR2GRAY)
        s, _, _, sc = self._best(g, "chev")
        return s, sc

    def maybe_banner(self, banner_bgr: np.ndarray) -> bool:
        """Cheap initial filter for possible chevron or handshake matches; compute full features only for these frames when learning anchors."""
        g = cv2.cvtColor(np.ascontiguousarray(banner_bgr[ROW0:ROW1]), cv2.COLOR_BGR2GRAY)
        if self._best(g, "chev")[0] >= 0.6:
            return True
        return self._best(g, "hand")[0] >= 0.85
