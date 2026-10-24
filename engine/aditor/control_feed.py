"""Apex Control: identify the local player's immediate kill-feed rows, not delayed score notices."""
from __future__ import annotations

import cv2
import numpy as np

from .detect import _despeckle, white_mask
from .mixtape import MixtapeDetector, text_match
from .models import Event
from .scene import CONTROL_THRESHOLD, SceneDetector

# shortcut: the recorded HUD ends its feed at x=1820, calibrate this edge if custom HUD safe areas are supported.
FEED_RIGHT = 1820


def glyph(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) < 15:
        return None
    return mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.float32)


def similarity(a, b):
    if a is None or b is None:
        return 0.0
    return float(cv2.matchTemplate(a, b, cv2.TM_CCOEFF_NORMED)[0, 0])


def player_similarity(actor, player):
    if actor is None or player is None:
        return 0.0
    if not 0.8 <= (actor.shape[1] / actor.shape[0]) / (player.shape[1] / player.shape[0]) <= 1.25:
        return 0.0
    actor, player = (cv2.resize(m, (128, 24)) for m in (actor, player))
    # Feed names use a heavier font than the HUD; preserve whole-name alignment.
    return max(float(cv2.matchTemplate(cv2.copyMakeBorder(actor, 1, 1, 1, 1, cv2.BORDER_CONSTANT),
                                      cv2.dilate(player, np.ones((k, k), np.uint8)),
                                      cv2.TM_CCOEFF_NORMED).max()) for k in (1, 3))


class ControlFeed:
    def __init__(self, profile):
        self.profile = profile
        self.names = MixtapeDetector(profile)
        for path in sorted(profile.dir.glob('control_speaker*.png')):
            speaker = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_GRAYSCALE)
            if speaker is None:
                raise ValueError(f'Could not read speaker template: {path}')
            self.names.speakers.append(speaker.astype(np.float32) / 255)
        scene_dir = profile.dir.parent / 'scene'
        self.scene = SceneDetector(scene_dir if scene_dir.is_dir() else None, layout=profile.layout)
        self.active = False
        self.player = None
        self.entries = []
        self.events = []

    def player_name(self, spec):
        sx, sy, _, _ = self.profile.spec_roi
        if sy > 962 or sy + spec.shape[0] < 990:
            return None
        hud = spec[962 - sy:990 - sy, max(0, 172 - sx):max(0, 420 - sx)]
        if not hud.size:
            return None
        mask = (white_mask(hud, self.profile.white) > 0).astype(np.float32)
        limit = mask.shape[1]
        for level in (200, 170, 140):
            hm = (white_mask(hud, {**self.profile.white, 'v_min': level}) > 0).astype(np.float32)
            for speaker in self.names.speakers:
                score, x, _ = text_match(hm, speaker)
                if score >= 0.75:
                    limit = min(limit, x)
        return glyph(mask[:, :limit])

    def rows(self, feed, spec):
        player = self.player if self.player is not None else self.player_name(spec)
        if player is None:
            return []
        # The feed's local-player name is cyan. Require its complete glyphs to match the HUD name as well.
        b, g, r = cv2.split(feed.astype(np.float32))
        cyan = _despeckle((b > 110) & (g > 140) & (r < g * 0.8) & (b < g * 1.12))
        ys = np.flatnonzero(cyan.sum(axis=1) >= 4)
        bands = np.split(ys, np.flatnonzero(np.diff(ys) > 3) + 1)
        rows = []
        for band in bands:
            if len(band) < 7 or band[0] + self.profile.killfeed_roi[1] < 180:
                continue
            y0, y1 = max(0, band[0] - 2), min(feed.shape[0], band[-1] + 3)
            name = cyan[y0:y1]
            xs = np.flatnonzero(name.any(axis=0))
            if not xs.size:
                continue
            parts = np.split(xs, np.flatnonzero(np.diff(xs) > 12) + 1)
            actor = max(parts, key=lambda cols: player_similarity(glyph(name[:, cols[0]:cols[-1] + 1]), player))
            if player_similarity(glyph(name[:, actor[0]:actor[-1] + 1]), player) < 0.50:
                continue
            x0 = int(actor[-1]) + 12
            row = feed[y0:y1, x0:FEED_RIGHT - self.profile.killfeed_roi[0]]
            if not row.size:
                continue
            rb, rg, rr = cv2.split(row.astype(np.float32))
            mask = _despeckle((rr > 140) & (rr > rg * 1.15) & (rr > rb * 1.5))
            victim = glyph(mask)
            if victim is not None and victim.shape[0] >= 8 and victim.shape[1] >= 8:
                left = int(np.flatnonzero(mask.any(axis=0))[0])
                if left == 0:
                    continue
                weapon = white_mask(row[:, :left], {'v_min': 170, 's_max': 80})
                if weapon.size == 0 or np.count_nonzero(weapon) < 20 or np.count_nonzero(weapon.any(axis=0)) < 12:
                    continue
                # The feed is right-aligned: retain that alignment when some name strokes fade or are occluded.
                sig = np.zeros((24, 400), np.float32)
                width = min(400, mask.shape[1])
                sig[:, -width:] = cv2.resize(mask[:, -width:].astype(np.float32), (width, 24))
                if np.count_nonzero(sig) >= 15:
                    rows.append(sig)
                    self.player = player
        return rows

    def feed(self, t, feed, spec, thumb=None):
        if feed is None:
            return
        if thumb is not None:
            scene = self.scene.classify(thumb, full_scores=False)
            if scene.kind in ('pre_match', 'lobby'):
                self.active = False
                self.player = None
                self.entries.clear()
        ref = np.zeros((360, 640), np.uint8)
        x, y, w, h = self.profile.killfeed_roi
        ref[y // 3:(y + h) // 3, x // 3:(x + w) // 3] = cv2.resize(
            cv2.cvtColor(feed, cv2.COLOR_BGR2GRAY), ((x + w) // 3 - x // 3, h // 3))
        if self.scene._match_score(ref, 'control_objectives') >= CONTROL_THRESHOLD:
            self.active = True
        if not self.active:
            return
        self.entries = [e for e in self.entries if t - e['last'] < 2]
        used = set()
        for sig in self.rows(feed, spec):
            candidates = [(max(similarity(old, sig) for old in e['sigs']), i)
                          for i, e in enumerate(self.entries) if i not in used]
            score, index = max(candidates, default=(0, -1))
            if score < 0.60:
                self.entries.append(dict(sigs=[sig], first=t, last=t, hits=1, emitted=False))
                used.add(len(self.entries) - 1)
                continue
            used.add(index)
            entry = self.entries[index]
            entry['sigs'] = [entry['sigs'][0], *(entry['sigs'][1:] + [sig])[-3:]]
            entry['hits'] = entry['hits'] + 1 if t - entry['last'] <= 0.5 else 1
            entry['last'] = t
            if entry['hits'] >= 2 and not entry['emitted']:
                first = entry['first']
                ordinal = sum(e.t == first for e in self.events)
                self.events.append(Event(id=f'f{round(first * 1000)}-{ordinal}', t=first,
                                         type='kill', score=score, damage_line=False, name_sig=None))
                entry['emitted'] = True
