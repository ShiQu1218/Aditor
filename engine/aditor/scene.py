"""Text-independent scene-frame matching used only for match segmentation; it does not affect kill detection."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import cv2
import numpy as np

from .layout import Layout

SceneKind = Literal["pre_match", "lobby", "in_match_hud", "other"]
SCENE_SIZE = (640, 360)
BASE_SIZE = (1920, 1080)
# Coordinates below use a 1920×1080 reference. Offline frames are first resized to 640×360, then cropped to local regions.
# Each ROI's min_size is the minimum pixel size required for transmission; fps is the minimum sampling rate; anchor is the
# screen edge the element keeps its distance to when the game renders at a narrower aspect (see layout.py).
SCENE_ROIS = {
    "mode_card": {"rect": (285, 45, 210, 165), "min_size": (70, 55), "fps": 1, "anchor": "top"},
    "loading_footer": {"rect": (711, 828, 498, 84), "min_size": (166, 28), "fps": 1, "anchor": "bottom"},
    "wildcard_footer": {"rect": (711, 471, 498, 84), "min_size": (166, 28), "fps": 1, "anchor": "center"},
    "ready_button": {"rect": (741, 891, 444, 165), "min_size": (148, 55), "fps": 1, "anchor": "bottom"},
    "mode_selector": {"rect": (0, 804, 447, 255), "min_size": (149, 85), "fps": 1, "anchor": "bottom"},
    "minimap": {"rect": (21, 21, 309, 375), "min_size": (103, 125), "fps": 1, "anchor": "top"},
    "health": {"rect": (99, 873, 366, 183), "min_size": (122, 61), "fps": 1, "anchor": "bottom"},
    "summary_tabs": {"rect": (588, 60, 750, 102), "min_size": (250, 34), "fps": 1, "anchor": "top"},
}


@dataclass(frozen=True)
class SceneFrame:
    kind: SceneKind
    # Keep the summary classified as other; use only the positive frame to recover the state where recording
    # starts at the end of the previous match.
    match_context: bool = False
    scores: dict[str, float] = field(default_factory=dict, compare=False)
    # A fully black frame means the game is not in the foreground during DDA capture, so the recorder sends
    # a black frame and the game state is unavailable.
    blank: bool = False


# Templates use SCENE_SIZE coordinates; the search area allows for small position and scale errors.
_TEMPLATES = {
    "mode_chevron": ((95, 15, 70, 55), (132, 20)),
    "loading_footer": ((237, 276, 166, 28), (242, 281)),
    "wildcard_footer": ((237, 157, 166, 28), (242, 162)),
    "ready_border": ((247, 297, 148, 55), (252, 302)),
    "mode_border": ((0, 268, 149, 85), (0, 273)),
    "minimap_border": ((7, 7, 103, 125), (12, 12)),
    "health_border": ((37, 313, 116, 39), (42, 318)),
    "ranked_minimap": ((7, 7, 103, 103), (12, 12)),
    "spectator_minimap": ((7, 27, 103, 103), (12, 32)),
    "ranked_health": ((33, 312, 120, 39), (38, 317)),
    "spectator_health": ((33, 291, 122, 39), (38, 296)),
    "summary_tabs": ((196, 20, 250, 34), (201, 25)),
}
PRE_MATCH_THRESHOLD = 0.75
LOBBY_THRESHOLD = 0.70
HUD_THRESHOLD = 0.60
SUMMARY_THRESHOLD = 0.80
# A thumbnail is considered black when its brightest pixel is at or below this value (allowing for encoded black-level offset).
BLANK_MAX_LEVEL = 8


class SceneDetector:
    def __init__(self, template_dir: Path | None = None, layout: Layout | None = None):
        self._layout = layout or Layout(1.0)
        template_dir = template_dir or Path(__file__).resolve().parents[2] / "templates" / "scene"
        self._templates = {}
        for name in _TEMPLATES:
            images = []
            for suffix in ("", "_mask"):
                path = template_dir / f"{name}{suffix}.png"
                img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
                if img is None:
                    raise ValueError(f"Could not read scene template: {path}")
                images.append(img)
            self._templates[name] = tuple(images)

    def classify(self, frame: np.ndarray) -> SceneFrame:
        """Accept a full-frame uint8 BGR or grayscale image; reject undersized input to avoid artificial upscaling."""
        if frame.dtype != np.uint8 or frame.ndim not in (2, 3):
            raise ValueError("Scene frame must be uint8 BGR or grayscale")
        if frame.ndim == 3:
            if frame.shape[2] != 3:
                raise ValueError("Scene frame must have three BGR channels")
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h, w = frame.shape
        if w < SCENE_SIZE[0] or h < SCENE_SIZE[1]:
            raise ValueError("Current scene settings require at least 640×360; provide a scene ROI or a larger full frame")
        gray = cv2.resize(frame, SCENE_SIZE, interpolation=cv2.INTER_AREA)
        ref = self._layout.reference_thumb(gray)
        scores = {}
        for name, (roi, _) in _TEMPLATES.items():
            x, y, rw, rh = roi
            template, mask = self._templates[name]
            result = cv2.matchTemplate(ref[y:y + rh, x:x + rw], template,
                                       cv2.TM_CCOEFF_NORMED, mask=mask)
            finite = result[np.isfinite(result)]
            scores[name] = float(finite.max()) if finite.size else 0.0
        footer = max(scores["loading_footer"], scores["wildcard_footer"])
        if min(scores["mode_chevron"], footer) >= PRE_MATCH_THRESHOLD:
            return SceneFrame("pre_match", scores=scores)
        if min(scores["ready_border"], scores["mode_border"]) >= LOBBY_THRESHOLD:
            return SceneFrame("lobby", scores=scores)
        minimap = max(scores["minimap_border"], scores["ranked_minimap"], scores["spectator_minimap"])
        health = max(scores["health_border"], scores["ranked_health"], scores["spectator_health"])
        if min(minimap, health) >= HUD_THRESHOLD:
            return SceneFrame("in_match_hud", scores=scores)
        return SceneFrame("other", scores["summary_tabs"] >= SUMMARY_THRESHOLD, scores,
                          blank=int(gray.max()) <= BLANK_MAX_LEVEL)
