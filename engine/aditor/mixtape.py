"""Text-only Mixtape banners with native Traditional Chinese and English keyword crops.

Unlike BR score banners these have no icons or damage line. Require the centered
keyword/name layout and the local player's HUD, and reject a victim matching that
HUD name (the kill camera can replay the player's own elimination).
"""
from pathlib import Path

import cv2
import numpy as np

from .models import FrameResult, NameSig


def text_match(ink, template):
    """Ignore flat patches: normalized float correlation is unstable there."""
    h, w = template.shape
    if ink.shape[0] < h or ink.shape[1] < w:
        return 0.0, 0, 0
    result = cv2.matchTemplate(ink, template, cv2.TM_CCOEFF_NORMED)
    mean = cv2.boxFilter(ink, -1, (w, h), anchor=(0, 0))[:result.shape[0], :result.shape[1]]
    square = cv2.boxFilter(ink * ink, -1, (w, h), anchor=(0, 0))[:result.shape[0], :result.shape[1]]
    result = np.where((square - mean * mean >= 0.01) & np.isfinite(result), result, 0)
    _, score, _, (x, y) = cv2.minMaxLoc(result)
    return float(score), x, y


class MixtapeDetector:
    def __init__(self, profile):
        self.profile = profile
        self.templates = []
        speaker_path = Path(profile.dir) / "mixtape_speaker.png"
        self.speakers = []
        if speaker_path.exists():
            speaker = cv2.imdecode(np.fromfile(str(speaker_path), np.uint8), cv2.IMREAD_GRAYSCALE)
            if speaker is not None:
                self.speakers = [cv2.resize(speaker, None, fx=s, fy=s).astype(np.float32) / 255.0
                                 for s in (0.9, 1.0, 1.1)]
        for kind, name in (("kill", "mixtape_elim_zh"), ("assist_elim", "mixtape_assist_zh"),
                           ("kill", "mixtape_elim_en"), ("assist_elim", "mixtape_assist_en")):
            path = Path(profile.dir) / f"{name}.png"
            if path.exists():
                template = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_GRAYSCALE)
                if template is not None:
                    for scale in (0.9, 0.95, 1.0, 1.05, 1.1):
                        self.templates.append((kind, cv2.resize(template, None, fx=scale, fy=scale)
                                               .astype(np.float32) / 255.0))

    def detect(self, banner, spec):
        from .detect import _despeckle, ink_mask, name_sig_similarity, name_strokes, red_mask, white_mask

        # Legacy/foreign profiles do not capture the player name. Never guess
        # ownership when it is unavailable. Coordinates are reference-layout.
        sx, sy, _, _ = self.profile.spec_roi
        if not self.templates or not (sy <= 962 and sy + spec.shape[0] >= 990):
            return None
        hud = spec[962 - sy:990 - sy, max(0, 172 - sx):max(0, 420 - sx)]
        if not hud.size:
            return None
        hud_mask = _despeckle(white_mask(hud, self.profile.white) > 0).astype(np.float32)
        if np.count_nonzero(hud_mask) < 35:
            return None
        # The text-only banner is centered at y≈780, inside the usual banner ROI.
        band = banner[50:110]
        ink = ink_mask(band, self.profile)
        best = None
        for kind, template in self.templates:
            score, x, y = text_match(ink, template)
            # The elimination word is also inside the assist prefix. A complete
            # assist-prefix match takes precedence over that shorter substring.
            if score >= 0.80 and (best is None or (kind == "assist_elim", score)
                                  > (best[3] == "assist_elim", best[0])):
                best = (score, x, y, kind, template.shape)
        if best is None:
            return None
        score, x, y, kind, (h, w) = best
        uncertain = FrameResult(None, 0.0, 0, False, None, False, hint="plain_cont")
        # Search only the adjacent name, on the same text baseline.
        row = band[y:y + h, x + w:min(800, 800 - x + 4)]
        if row.size == 0:
            return None
        if kind == "kill":
            hsv = cv2.cvtColor(row, cv2.COLOR_BGR2HSV)
            # Compressed color-blind yellow can shift toward amber and fall
            # outside the stricter BR signature rule.
            yellow = ((hsv[..., 0] >= 15) & (hsv[..., 0] <= 40)
                      & (hsv[..., 1] >= 90) & (hsv[..., 2] >= 120))
            mask = (red_mask(row, self.profile, pink=True) > 0) | yellow
        else:
            mask = white_mask(row, {**self.profile.white, 'v_min': 170}) > 0
        strokes = _despeckle(mask & (ink_mask(row, self.profile) >= 0.25))
        if np.count_nonzero(strokes) < 35:
            strokes = _despeckle(mask & (name_strokes(row) >= 25))
        mask = strokes
        cols = np.flatnonzero(mask.any(axis=0))
        if cols.size < 4 or cols[0] > 15:
            return uncertain
        # A blank gap ends the name, excluding the background beyond the plate.
        end = int(cols[-1]) + 1
        gaps = np.flatnonzero(np.diff(cols) > 18)
        for gap in gaps:
            candidate = int(cols[gap]) + 1
            if candidate - int(cols[0]) >= 8 and abs((2 * x + w + candidate) / 2 - 400) <= 4:
                end = candidate
                break
        start = int(cols[0])
        # The complete keyword + name must straddle the screen center.
        if abs((x + x + w + end) / 2 - 400) > 24:
            return uncertain
        glyph = mask[:, start:end]
        rows = np.flatnonzero(glyph.any(axis=1))
        if not rows.size:
            return uncertain
        glyph = glyph[rows[0]:rows[-1] + 1].astype(np.float32)
        gh, gw = glyph.shape
        if gh < 9 or gw < 8 or glyph.mean() < 0.08:
            return uncertain
        # Match complete names, never a victim substring inside the HUD name.
        # The optional trailing speaker is an icon, not part of that name.
        masks = [_despeckle(white_mask(hud, {**self.profile.white, "v_min": level}) > 0)
                 for level in (200, 170, 140)]
        name_limit = hud.shape[1]
        for hm in masks:
            for speaker in self.speakers:
                match, speaker_x, _ = text_match(hm.astype(np.float32), speaker)
                tail = hm[:, speaker_x + speaker.shape[1]:]
                if match >= 0.75 and not tail.any():
                    name_limit = min(name_limit, speaker_x)
        # Some banners capitalize Latin names while the HUD keeps their case.
        # Compare full stroke images as well as binary glyphs to tolerate this.
        vi = cv2.resize(ink_mask(row, self.profile)[rows[0]:rows[-1] + 1, start:end], (128, 16))
        victim_bits = cv2.resize(glyph, (128, 16))
        hud_ink = ink_mask(hud, self.profile)
        for hm in masks:
            hm = hm[:, :name_limit]
            hc = np.flatnonzero(hm.any(axis=0))
            if not hc.size:
                continue
            hstart = int(hc[0])
            # Vary only the outer glyph edge, not internal word boundaries.
            ends = sorted({min(name_limit, int(hc[-1]) + 1 + delta) for delta in (-1, 0, 1, 2)})
            for hend in ends:
                hr = np.flatnonzero(hm[:, hstart:hend].any(axis=1))
                if not hr.size or not 0.7 <= (hend - hstart) / (gw * (hr[-1] - hr[0] + 1) / gh) <= 1.3:
                    continue
                hi = cv2.resize(hud_ink[hr[0]:hr[-1] + 1, hstart:hend], (128, 16))
                hud_bits = cv2.resize(hm[hr[0]:hr[-1] + 1, hstart:hend].astype(np.float32), (128, 16))
                if name_sig_similarity(NameSig(128, hud_bits), NameSig(128, victim_bits)) >= 0.62:
                    return None
                prefix = name_sig_similarity(NameSig(50, hi[:, :50]), NameSig(50, vi[:, :50]))
                suffix = name_sig_similarity(NameSig(23, hi[:, -23:]), NameSig(23, vi[:, -23:]))
                if (prefix >= 0.70 and suffix >= 0.70
                        and name_sig_similarity(NameSig(128, hi), NameSig(128, vi)) >= 0.45):
                    return None
        # Keep the keyword's baseline instead of rescaling names when a few strokes fade or are covered.
        event_glyph = mask[:, start:end].astype(np.float32)
        width = max(1, round(gw * NameSig.HEIGHT / event_glyph.shape[0]))
        sig = NameSig(width, (cv2.resize(event_glyph, (width, NameSig.HEIGHT)) >= 0.5).astype(np.uint8))
        return FrameResult(kind, score, x, False, sig, False, hint="plain")
