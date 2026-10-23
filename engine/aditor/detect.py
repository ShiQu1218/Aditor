"""Per-frame detection converts (banner, spec) into a FrameResult using icon detection, enemy-name signatures, and spectator banners (spec §5.2).

Also contains name-signature comparison helpers (same_name/fragment_of) shared by events and derive."""
from __future__ import annotations

import base64
from dataclasses import dataclass

import cv2
import numpy as np

from pathlib import Path

from .icon_detect import IconDetector, IconFrame, IconParams
from .models import FrameResult, NameSig
from .mixtape import MixtapeDetector
from .profile import Profile

TEXT_H = 22  # Height in pixels of the first banner text line at 1080p; used to detect whitespace after the name.

# Pink fallback fingerprints must have at least this ink density (real names are about 0.2–0.3), to avoid treating sparse peach pixels in the scene as a name.
PINK_FALLBACK_MIN_DENSITY = 0.12


def _imread_gray(path) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)


def white_mask(img_bgr: np.ndarray, white: dict) -> np.ndarray:
    """Map high-value, low-saturation pixels to uint8 0/255. white = {"v_min", "s_max"}."""
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    ok = (hsv[..., 2] >= white["v_min"]) & (hsv[..., 1] <= white["s_max"])
    return ok.astype(np.uint8) * 255


def red_mask(img_bgr: np.ndarray, profile: Profile, pink: bool = False) -> np.ndarray:
    """Map pixels with high R and low G/B to uint8 0/255. When pink=True, also include the pink (green color-blind) rule as a fallback for name fingerprints."""
    b, g, r = img_bgr[..., 0], img_bgr[..., 1], img_bgr[..., 2]
    ok = (r >= profile.red["r_min"]) & (g <= profile.red["g_max"]) & (b <= profile.red["b_max"])
    if "r_diff_min" in profile.red:
        ok = ok & (r.astype(np.int16) - np.maximum(g, b).astype(np.int16) >= profile.red["r_diff_min"])
    y = profile.red.get("yellow")
    if y:
        # In red/blue color-blind modes, enemy names are yellow: R and G are high and close, while B is low. Behavior is unchanged when unset (zh-TW).
        r16, g16, b16 = r.astype(np.int16), g.astype(np.int16), b.astype(np.int16)
        ok = ok | ((r16 >= y["r_min"]) & (g16 >= y["g_min"]) & (b16 <= y["b_max"])
                   & (r16 - b16 >= y["rb_min"]) & (np.abs(r16 - g16) <= y["rg_max"]))
    pk = profile.red.get("pink") if pink else None
    if pk:
        # In green color-blind mode, enemy names are pink (about R 220, G 152, B 163): R is high and clearly above G, and B is at least G (excluding orange/skin-tone scenes).
        r16, g16, b16 = r.astype(np.int16), g.astype(np.int16), b.astype(np.int16)
        ok = ok | ((r16 >= pk["r_min"]) & (g16 >= pk["g_min"]) & (r16 - g16 >= pk["rg_min"]) & (b16 - g16 >= pk["bg_min"])
                   & (r16 - b16 >= pk["rb_min"]))
    return ok.astype(np.uint8) * 255


def name_sig_similarity(a: NameSig, b: NameSig) -> float:
    """Correlation (-1..1) between two name fingerprints. Resize b to a's width before comparing if their widths differ."""
    ba = a.bits.astype(np.float32)
    bb = b.bits.astype(np.float32)
    if bb.shape[1] != ba.shape[1]:
        bb = cv2.resize(bb, (ba.shape[1], ba.shape[0]), interpolation=cv2.INTER_AREA)
    # Apply slight blur to tolerate 1 px stroke misalignment (red and white text edges differ due to scaling and sampling).
    ba = cv2.GaussianBlur(ba, (3, 3), 0.8)
    bb = cv2.GaussianBlur(bb, (3, 3), 0.8)
    ba = ba - ba.mean()
    bb = bb - bb.mean()
    den = float(np.sqrt((ba * ba).sum() * (bb * bb).sum()))
    if den < 1e-6:
        return 0.0
    return float((ba * bb).sum() / den)


def _ink_box(mask: np.ndarray, pad: int = 8, rows_limit: tuple[int, int] | None = None
             ) -> tuple[int, int, int, int]:
    """Return the bounding box (x0, y0, x1, y1) of nonzero mask pixels, expanded by pad; return an empty box for an all-black mask. This is only an optimization.
    rows_limit first restricts the row range to [y0, y1)."""
    if rows_limit is not None:
        lo, hi = rows_limit
        x0, y0, x1, y1 = _ink_box(mask[lo:hi], pad)
        return x0, y0 + lo, x1, y1 + lo
    rows = np.flatnonzero(mask.any(axis=1))
    if rows.size == 0:
        return 0, 0, 0, 0
    cols = np.flatnonzero(mask.any(axis=0))
    h, w = mask.shape
    return (max(0, int(cols[0]) - pad), max(0, int(rows[0]) - pad),
            min(w, int(cols[-1]) + 1 + pad), min(h, int(rows[-1]) + 1 + pad))


def same_name(a: NameSig | None, b: NameSig | None, threshold: float) -> bool:
    """Whether two name fingerprints belong to the same enemy: return False if either is None or their width ratio differs by >= 15%;
    otherwise require correlation >= threshold (profile.name_sig_threshold)."""
    if a is None or b is None:
        return False
    if abs(a.width - b.width) / max(a.width, b.width) >= 0.15:
        return False
    return name_sig_similarity(a, b) >= threshold


FRAGMENT_MIN_WIDTH = 30    # Minimum width of the shorter fingerprint for fragment matching (narrower fragments often correlate by chance with other names).
FRAGMENT_THRESHOLD = 0.70  # Maximum sliding correlation threshold for the shorter fingerprint against the longer one.


def fragment_of(a: NameSig | None, b: NameSig | None) -> bool:
    """Whether one fingerprint is an occluded/faded fragment of the other (same enemy): width difference >= 15% and the
    maximum sliding correlation of the shorter against the longer >= FRAGMENT_THRESHOLD. Similar-width comparisons use same_name.

    Thresholds are based on name fingerprints from fixtures in all three languages: different-name pairs with width >= 30
    have a maximum sliding correlation of about 0.53 (p99 0.48); 40–75% fragments of the same name (including 4% bit noise)
    score at least 0.9."""
    if a is None or b is None:
        return False
    short, long_ = (a, b) if a.width <= b.width else (b, a)
    if short.width < FRAGMENT_MIN_WIDTH or (long_.width - short.width) / long_.width < 0.15:
        return False
    ps = cv2.GaussianBlur(short.bits.astype(np.float32), (3, 3), 0.8)
    pl = cv2.GaussianBlur(long_.bits.astype(np.float32), (3, 3), 0.8)
    ps = ps - ps.mean()
    ns = float(np.sqrt((ps * ps).sum()))
    if ns < 1e-6:
        return False
    res = cv2.matchTemplate(pl, ps, cv2.TM_CCOEFF_NORMED)
    return bool(np.isfinite(res).any() and float(np.nanmax(res)) >= FRAGMENT_THRESHOLD)


def _segments(cols: np.ndarray) -> list[tuple[int, int]]:
    """Split a Boolean array indicating whether each column contains ink into contiguous ranges [(start, end)], inclusive."""
    idx = np.flatnonzero(cols)
    if idx.size == 0:
        return []
    brk = np.flatnonzero(np.diff(idx) > 1)
    starts = np.concatenate(([idx[0]], idx[brk + 1]))
    ends = np.concatenate((idx[brk], [idx[-1]]))
    return list(zip(starts.tolist(), ends.tolist()))


def _despeckle(ink: np.ndarray, min_area: int = 3) -> np.ndarray:
    """Remove ink that does not resemble glyph strokes: large bright regions (fire or reflections; strokes are < 5 px wide,
    so detect these with a 5x5 opening), isolated noise, and thin lines (horizontal lines or sparse diagonals)."""
    u8 = ink.astype(np.uint8)
    thick = cv2.morphologyEx(u8, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    if thick.any():
        u8 = u8 & ~cv2.dilate(thick, np.ones((3, 3), np.uint8), iterations=2)
    n, lab, st, _ = cv2.connectedComponentsWithStats(u8, connectivity=8)
    w, h = st[:, cv2.CC_STAT_WIDTH], st[:, cv2.CC_STAT_HEIGHT]
    area = st[:, cv2.CC_STAT_AREA]
    streak = ((h <= 4) & (w >= 14)) | ((w >= 20) & (area < 0.12 * w * h))
    keep = (area >= min_area) & ~streak
    keep[0] = False
    return keep[lab]


def _weak_sig(sig: NameSig | None, min_density: float = 0.03) -> bool:
    """Whether the fingerprint is empty or its ink density is below min_density (strokes are too thin or only noise remains, so it is not discriminative)."""
    return sig is None or float(sig.bits.mean()) < min_density


def name_sig_from_row(row_bgr: np.ndarray, profile: Profile, pink: bool = False) -> NameSig | None:
    """Extract the enemy name fingerprint from a crop of the first text line (x range from the line's left edge to the "+" sign),

    then resize it to a 16-pixel-tall binary glyph. Ink combines enemy-name colors (red/yellow, plus pink when pink=True)
    with white text; remove large bright regions and noise first. Determine the name range from enemy-colored columns
    (starting at the first run; gaps <= 1.5 text heights are included, larger gaps end the name), then take all ink in that range.
    This excludes the keyword (white text) from the fingerprint, making it language-independent."""
    if row_bgr.size == 0:
        return None
    red = red_mask(row_bgr, profile, pink) > 0
    ink = _despeckle((white_mask(row_bgr, profile.white) > 0) | red)
    red = red & ink
    segs = _segments(red.any(axis=0))
    if not segs:
        return None
    start, end = segs[0]
    for c0, c1 in segs[1:]:
        if c0 - end - 1 > 1.5 * TEXT_H:
            break
        end = c1
    block = ink[:, start:end + 1]
    rows = np.flatnonzero(block.any(axis=1))
    block = block[rows[0]:rows[-1] + 1].astype(np.float32)
    bh, bw = block.shape
    if bw < 4:
        return None
    w16 = max(1, int(round(bw * NameSig.HEIGHT / bh)))
    small = cv2.resize(block, (w16, NameSig.HEIGHT), interpolation=cv2.INTER_AREA)
    return NameSig(w16, (small >= 0.5).astype(np.uint8))


def _match(mask: np.ndarray, tpl: np.ndarray, box=None) -> tuple[float, int, int]:
    """Return (best score, x, y) in mask coordinates. box restricts the search area; an area smaller than the template is a miss."""
    ox = oy = 0
    if box is not None:
        ox, oy, x1, y1 = box
        mask = mask[oy:y1, ox:x1]
    if mask.shape[0] < tpl.shape[0] or mask.shape[1] < tpl.shape[1]:
        return 0.0, 0, 0
    res = cv2.matchTemplate(mask, tpl, cv2.TM_CCOEFF_NORMED)
    _, mx, _, loc = cv2.minMaxLoc(res)
    if not np.isfinite(mx):
        return 0.0, 0, 0
    return float(mx), int(loc[0]) + ox, int(loc[1]) + oy


def read_name_sig(row_bgr: np.ndarray, profile: Profile) -> NameSig | None:
    """Name fingerprint fallback: use the pink (green color-blind) rule when standard red/yellow rules do not produce a usable glyph."""
    sig = name_sig_from_row(row_bgr, profile, False)
    if _weak_sig(sig, PINK_FALLBACK_MIN_DENSITY) and "pink" in profile.red:
        alt = name_sig_from_row(row_bgr, profile, True)
        if not _weak_sig(alt, PINK_FALLBACK_MIN_DENSITY) and (sig is None or alt.bits.mean() > sig.bits.mean()):
            return alt
    return sig


# ---- Per-video learned kill keyword templates (language-independent validation) ----
# The solo score icon also appears in many non-kill banners (e.g. weak-champion rewards, flag returns, enemy squad wipes,
# safe-zone notices, evolution orbs); even the score can match assists. Only the banner text differs, and text varies by
# language, so learn templates from each video instead of using fixed text templates:
# - Assist prefix: the first few characters to the right of the reliable handshake icon in an assist-elimination banner;
#   assist-knock banners start with the same text but have no handshake icon.
# - Knock keyword: text to the left of the name in a reliable knock banner (enemy-colored name plus damage line); in assist-knock
#   banners it is also before the name in most languages, while Japanese relies on the assist prefix.
# A candidate banner counts as a kill banner when its first-line white-text mask has normalized maximum correlation >= KW_THRESHOLD.
KW_THRESHOLD = 0.7      # H950 development set: true-banner frame p25 0.93 (p10 0.6–0.66); non-kill banner p99 0.62–0.68.
PREFIX_W = 64           # Assist-prefix template width in pixels at calibrated scale.
KEYWORD_W = 36          # Knock-keyword template width to the left of the name.
KW_MIN_INK = 0.04       # Minimum template stroke ratio to avoid an empty template.


INK_SCALE = 100.0       # Top-hat brightness difference at which a stroke reaches full weight (continuous 0–1 values).
_INK_K = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))


def ink_mask(bgr: np.ndarray, profile: Profile) -> np.ndarray:
    """Text-stroke image for keyword templates (continuous 0–1 values): a local top-hat measuring the brightness difference
    of thin bright strokes from the local background. Avoid an absolute white threshold: low-contrast recordings (text in
    acceptance clip test-TC is gray; the old text method scored only 0.49–0.60) lose strokes, while bright backgrounds
    (snow, sky, sand) introduce background blocks. Continuous values avoid the high correlation between binary text patterns
    (40–75% false acceptance of non-kill banners on H950); with a higher KW_THRESHOLD, continuous values have < 1% false acceptance."""
    g = cv2.cvtColor(np.ascontiguousarray(bgr), cv2.COLOR_BGR2GRAY)
    th = cv2.morphologyEx(g, cv2.MORPH_TOPHAT, _INK_K).astype(np.float32)
    return np.clip(th / INK_SCALE, 0.0, 1.0)


def _match_max(mask: np.ndarray, tpl: np.ndarray) -> float:
    if mask.ndim < 2 or mask.shape[0] < tpl.shape[0] or mask.shape[1] < tpl.shape[1]:
        return 0.0
    res = cv2.matchTemplate(mask.astype(np.float32), tpl, cv2.TM_CCOEFF_NORMED)
    res = np.nan_to_num(res, nan=0.0, posinf=0.0, neginf=0.0)
    return float(res.max()) if res.size else 0.0


MIN_ANCHOR_BANNERS = 3  # Require anchors from at least 3 distinct banners: consecutive frames from one banner have nearly identical backgrounds, so only cross-banner voting removes bright backgrounds.


def _consensus(strips: list[np.ndarray], banners: int | None = None) -> np.ndarray | None:
    """Take a majority vote across ink masks from multiple anchors. Return None (disable the template) if there are fewer than
    MIN_ANCHOR_BANNERS anchor banners (use anchor count when banners is omitted) or the template contains almost no ink."""
    if (len(strips) if banners is None else banners) < MIN_ANCHOR_BANNERS:
        return None
    tpl = np.mean(strips, axis=0).astype(np.float32)   # Averaging across banners removes banner-specific backgrounds, leaving shared text.
    return tpl if float((tpl > 0.3).mean()) >= KW_MIN_INK else None


class Keywords:
    """The two templates learned for each video (None means there are not enough anchors and the template is disabled)."""

    def __init__(self, assist: np.ndarray | None = None, knock: np.ndarray | None = None,
                 assist_by_knock: bool = False):
        self.assist, self.knock = assist, knock
        # Whether assist-knock banners in this video contain the knock keyword (for example, Traditional Chinese and English do,
        # while Japanese does not); determined during learning from the number of assist-knock banners matching the knock keyword.
        self.assist_by_knock = assist_by_knock

    @property
    def empty(self) -> bool:
        return self.assist is None and self.knock is None

    def to_dict(self) -> dict:
        def enc(a):
            if a is None:
                return None
            q = np.clip(np.rint(a * 255.0), 0, 255).astype(np.uint8)
            return {"shape": list(a.shape), "q8": base64.b64encode(q.tobytes()).decode("ascii")}
        return {"assist": enc(self.assist), "knock": enc(self.knock), "assist_by_knock": self.assist_by_knock}

    @classmethod
    def from_dict(cls, d: dict | None) -> "Keywords":
        """Restore templates from cache; raise ValueError for invalid shapes, data lengths, or base64 so the caller can relearn them."""
        def dec(e):
            if not e:
                return None
            if not isinstance(e, dict):
                raise ValueError("Invalid keyword template format")
            shape = e.get("shape")
            if (not isinstance(shape, list) or len(shape) != 2
                    or any(isinstance(x, bool) or not isinstance(x, int) or x <= 0 for x in shape)):
                raise ValueError(f"Invalid keyword template shape: {shape!r}")
            h, w = shape
            raw = np.frombuffer(base64.b64decode(e.get("q8") or "", validate=True), dtype=np.uint8)
            if raw.size < h * w:
                raise ValueError("Keyword template data is too short")
            return (raw[: h * w].reshape(h, w).astype(np.float32)) / 255.0
        if d is not None and not isinstance(d, dict):
            raise ValueError("Invalid keyword template format")
        d = d or {}
        return cls(dec(d.get("assist")), dec(d.get("knock")), bool(d.get("assist_by_knock", False)))

    def scores(self, banner_bgr: np.ndarray, f, profile: Profile) -> tuple[float, float]:
        """Return (assist-prefix score, knock-keyword score); return -1 when the corresponding template is absent."""
        return self.scores_ink(keyword_ink(banner_bgr, f, profile), f)

    def scores_ink(self, m: np.ndarray, f) -> tuple[float, float]:
        """Same as scores, but input is the first-line stroke image already computed by keyword_ink (only this small region is saved for deferred validation)."""
        a = _match_max(m[:, :f.plus_x], self.assist) if self.assist is not None else -1.0
        k = _match_max(m[:, max(0, f.line_l - 4):f.plus_x], self.knock) if self.knock is not None else -1.0
        return a, k


def keyword_ink(banner_bgr: np.ndarray, f, profile: Profile) -> np.ndarray:
    """Keyword matching uses only the first line to the left of the "+" sign: the stroke-image region required by Keywords.scores_ink."""
    return row_ink(banner_bgr, f, profile, pad=5)[:, :max(0, f.plus_x)]


def row_ink(banner_bgr: np.ndarray, f, profile: Profile, pad: int = 2) -> np.ndarray:
    """Text-stroke image for the first line (same row as the arrow); see ink_mask."""
    y0 = max(0, f.chev_y - pad)
    y1 = min(banner_bgr.shape[0], f.chev_y + f.row_h + pad)
    return ink_mask(banner_bgr[y0:y1], profile)


def hand_strip(banner_bgr: np.ndarray, f, hand_hw: tuple[int, int], profile: Profile) -> np.ndarray | None:
    """Assist-elimination banner: text-stroke image PREFIX_W pixels to the right of the handshake icon (anchor for the assist prefix)."""
    th, tw = hand_hw
    x0 = f.hand_x + tw + 4
    b = banner_bgr[max(0, f.hand_y - 2):f.hand_y + th + 2, x0:x0 + PREFIX_W]
    if b.shape[1] != PREFIX_W or b.shape[0] < th + 2:
        return None
    return ink_mask(b, profile).astype(np.float32)


def knock_strip(banner_bgr: np.ndarray, f, profile: Profile) -> np.ndarray | None:
    """Knock banner: text-stroke image KEYWORD_W pixels to the left of the enemy-colored name (anchor for the knock keyword)."""
    y0 = max(0, f.chev_y - 2)
    y1 = min(banner_bgr.shape[0], f.chev_y + f.row_h + 2)
    row = banner_bgr[y0:y1, f.line_l:max(f.line_l, f.plus_x - 3)]
    if row.size == 0:
        return None
    red = red_mask(row, profile) > 0
    ink = _despeckle((white_mask(row, profile.white) > 0) | red)
    segs = _segments((red & ink).any(axis=0))
    if not segs or segs[0][0] < KEYWORD_W + 6:
        return None
    ns = segs[0][0]
    return ink_mask(row[:, ns - 6 - KEYWORD_W:ns - 6], profile).astype(np.float32)


# Banner types that do not indicate a kill but can appear alongside the current event (solo elimination, squad wipe, REVIVE/CRATE REVEAL, and other three-person score banners).
_OTHER_KINDS = frozenset({"elim", "squad_wipe", "score_other"})
PRODUCT_KINDS = frozenset({"knock", "assist_knock", "assist_elim", "kill"})


@dataclass(frozen=True)
class Pending:
    """Solo-score frame pending keyword validation (created by Detector.prepare and finalized by Detector.resolve). Keep only
    the small regions needed for validation, not the full banner, so frames can be buffered while learning and finalized later."""
    kind: str                 # Type inferred from the icon: knock/assist_knock.
    f: IconFrame
    ink: np.ndarray           # keyword_ink: first-line stroke image to the left of the "+" sign.
    sig: NameSig | None       # Enemy-name fingerprint for a knock (read only when the icon indicates a knock; used only if validation confirms it).
    spectating: bool


class Detector:
    """Single-frame detector: calibrate determines icon_scale once per video, then matching uses a single scale for speed."""

    def __init__(self, profile: Profile, icon_scale: float = 1.0, params: IconParams | None = None,
                 keywords: Keywords | None = None):
        self.profile = profile
        self.icon_scale = icon_scale
        self.set_keywords(keywords)
        self.icons = IconDetector(Path(profile.dir), scales=(icon_scale,), params=params)
        self.mixtape = MixtapeDetector(profile)
        # Group spectator templates by white-text threshold and compute one mask per group.
        groups: dict[tuple, list[tuple[np.ndarray, float]]] = {}
        for s in profile.spectating:
            groups.setdefault((s.white["v_min"], s.white["s_max"]), []).append(
                (_imread_gray(profile.dir / s.file), s.threshold))
        self._spec_groups = [({"v_min": k[0], "s_max": k[1]}, v) for k, v in groups.items()]

    def _spectating(self, spec_bgr: np.ndarray) -> bool:
        """A match from a spectator template in any language counts as spectating (see false-positive measurements in templates/icons/PROVENANCE.md)."""
        # The expanded capture also includes the player's name. Keep spectator
        # text matching in its original hint bar, not in that new HUD region.
        # Legacy 40px fixture/caller images already contain only the hint bar.
        _, sy, _, height = self.profile.spec_roi
        if sy < 1028 and spec_bgr.shape[0] == height:
            spec_bgr = spec_bgr[max(0, 1028 - sy):max(0, 1068 - sy)]
            if not spec_bgr.size:
                return False
        for white, tpls in self._spec_groups:
            sm = white_mask(spec_bgr, white)
            box = _ink_box(sm)
            if any(_match(sm, t, box)[0] >= thr for t, thr in tpls):
                return True
        return False

    def _knock_sig(self, banner_bgr: np.ndarray, f) -> NameSig | None:
        """Enemy-name fingerprint on the first line (same row as the arrow), between the line's left edge and the "+" sign; use pink (green color-blind) only if the standard mask does not yield a usable glyph."""
        y0, y1 = max(0, f.chev_y - 2), min(banner_bgr.shape[0], f.chev_y + f.row_h + 2)
        x1 = f.plus_x - 3 if f.plus_x > f.line_l + 8 else f.chev_x - 4
        row = banner_bgr[y0:y1, f.line_l:max(f.line_l, x1)]
        return read_name_sig(row, self.profile)

    def _verify(self, ink: np.ndarray, f, kind: str) -> str | None:
        """Validate solo-score banners with keyword templates learned from this video; skip validation when templates are absent.

        - An assist-prefix match (line starts with text such as "Assist,") means assist-knock; without an enemy-colored name,
          this corrects a knock misclassified from icon evidence.
        - A knock-keyword match preserves the type inferred from the icon.
        - No match returns None (not a kill banner). Validate only categories with a corresponding template: knocks need a knock
          template; assist-knocks need an assist-prefix template or assist banners in this video must contain the knock keyword
          (assist_by_knock). Preserve the original classification when no corresponding template can be learned from enough
          anchors (including Japanese-style assist banners that do not contain the knock keyword)."""
        kw = self.keywords
        if kw is None:
            return kind
        a, k = kw.scores_ink(ink, f)
        if a >= KW_THRESHOLD:
            return "assist_knock" if f.name_color - f.name_color_bg < self.icons.p.name_color_min else kind
        if k >= KW_THRESHOLD:
            return kind
        # Reject only categories with a corresponding validation template: knocks need a knock-keyword template; assist-knocks need an assist-prefix template.
        if kind == "knock":
            verifiable = kw.knock is not None
        else:
            verifiable = kw.assist is not None or (kw.assist_by_knock and kw.knock is not None)
        return None if verifiable else kind

    def set_keywords(self, keywords: Keywords | None) -> None:
        self.keywords = keywords if keywords is not None and not keywords.empty else None

    def detect(self, banner_bgr: np.ndarray, spec_bgr: np.ndarray) -> FrameResult:
        return self.resolve(self.prepare(banner_bgr, spec_bgr)[0])

    def prepare(self, banner_bgr: np.ndarray, spec_bgr: np.ndarray) -> tuple[FrameResult | Pending, IconFrame]:
        """Process the portion that does not need keyword templates; return (FrameResult or Pending validation, icon features)."""
        spectating = self._spectating(spec_bgr)
        f = self.icons.features(banner_bgr)
        p = self.icons.p
        kind = f.kind
        if kind in ("knock", "assist_knock"):
            sig = self._knock_sig(banner_bgr, f) if kind == "knock" else None
            ink = keyword_ink(banner_bgr, f, self.profile)  # Always save this in case keywords are provided later by set_keywords.
            return Pending(kind, f, ink, sig, spectating), f
        if kind == "assist_elim":
            return FrameResult(kind, f.hand, f.hand_x, False, None, spectating), f
        if kind in _OTHER_KINDS:
            # Other banners (solo elimination, squad wipe, REVIVE, etc.) count as no banner. A banner lasts at least ~2 seconds
            # (8 frames), so an uncertain icon classification in one frame is noise; >= 2 consecutive non-kill frames naturally
            # end the in-progress event under the GAP rule.
            return FrameResult(None, 0.0, 0, False, None, spectating), f
        if f.chev >= p.chev_min and f.plus >= p.plus_min:
            # Score arrow and "+" are present, but the person icon is uncertain (fade in/out): not a hit, but do not interrupt an in-progress event.
            return FrameResult(None, 0.0, 0, False, None, spectating, hint="cont"), f
        plain = self.mixtape.detect(banner_bgr, spec_bgr)
        if plain is not None and not spectating:
            return plain, f
        return FrameResult(None, 0.0, 0, False, None, spectating), f

    def resolve(self, r: FrameResult | Pending) -> FrameResult:
        """Finalize the result of prepare using the current keyword templates (set via set_keywords)."""
        if isinstance(r, FrameResult):
            return r
        f = r.f
        kind = self._verify(r.ink, f, r.kind)
        if kind is None:
            # Solo-score icon whose text is not a knock/assist (weak-champion reward, flag return, enemy squad wipe, etc.): treat as no banner.
            return FrameResult(None, 0.0, 0, False, None, r.spectating)
        sig = r.sig if kind == "knock" else None
        dmg = f.line2_ink - f.line2_ink_bg >= self.icons.p.line2_ink_min
        return FrameResult(kind, f.chev, f.chev_x, dmg, sig, r.spectating)
