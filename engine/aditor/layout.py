"""Game aspect ratio layout: map 1920×1080 reference ROIs into frames of games rendered at 4:3, 5:4, or 16:10.

Apex lays out its HUD for a 1920-wide canvas whose height follows the render aspect (1440 at 4:3), anchoring each
element to the top, center, or bottom. Stretched to fill a 16:9 capture (or captured at 4:3 and scaled by aditorrec/
decode.py to 1920×1080), widths and x positions stay unchanged while heights shrink by squash = aspect / (16/9) and
y positions move toward their anchor. Narrower-than-5:4 and wider-than-16:9 aspects are not offered by the game.
Letterboxed output (black side bars) is not handled: the capture is assumed to fill the game image.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np

Anchor = Literal["top", "center", "bottom"]
Rect = tuple[int, int, int, int]

BASE_W, BASE_H = 1920, 1080
REFERENCE_ASPECT = BASE_W / BASE_H
SUPPORTED_ASPECTS = {"16:9": 16 / 9, "16:10": 16 / 10, "4:3": 4 / 3, "5:4": 5 / 4}
# Ratios within this tolerance of a supported aspect are treated as that aspect (for example 1366×768 as 16:9).
ASPECT_TOLERANCE = 0.01
# HUD edges the kill banner and the spectator hint move with.
BANNER_ANCHOR: Anchor = "center"
SPEC_ANCHOR: Anchor = "bottom"
# Shipped banner_roi/spec_roi (templates/icons/profile.json) with their anchors; profile.json capture_rois must match.
CAPTURE_SPEC: dict[str, tuple[Rect, Anchor]] = {
    "banner": ((560, 700, 800, 180), BANNER_ANCHOR),
    "spec": ((60, 1028, 480, 40), SPEC_ANCHOR),
}


class LayoutError(ValueError):
    pass


@dataclass(frozen=True)
class Layout:
    squash: float  # Height of reference-layout content in the 16:9 frame relative to a 16:9 game (1.0 = no change).

    @classmethod
    def from_ratio(cls, ratio: float) -> "Layout":
        return cls(ratio / REFERENCE_ASPECT)

    @property
    def identity(self) -> bool:
        return self.squash == 1.0

    def source_rect(self, rect: Rect, anchor: Anchor) -> tuple[float, float, float, float]:
        """Where a reference-layout rect appears in the 1920×1080-normalized frame."""
        x, y, w, h = rect
        if self.identity:
            return rect
        k = self.squash
        if anchor == "top":
            top = y * k
        elif anchor == "bottom":
            top = BASE_H - (BASE_H - y) * k
        else:
            top = BASE_H / 2 + (y - BASE_H / 2) * k
        return (x, top, w, h * k)

    def extract(self, img: np.ndarray, capture: Rect, rect: Rect, anchor: Anchor) -> np.ndarray:
        """Cut the reference rect's content out of an image captured at `capture` and restore it to the reference size."""
        _, sy, _, sh = self.source_rect(rect, anchor)
        top = round(sy) - capture[1]
        bottom = round(sy + sh) - capture[1]
        if top < 0 or bottom > img.shape[0]:
            raise LayoutError(f"Capture rect {capture} does not contain {rect} at squash {self.squash}")
        x0 = rect[0] - capture[0]
        part = img[top:bottom, x0:x0 + rect[2]]
        if part.shape[0] == rect[3]:
            return part
        return cv2.resize(part, (rect[2], rect[3]), interpolation=cv2.INTER_LINEAR)

    def reference_thumb(self, thumb: np.ndarray) -> np.ndarray:
        """Rebuild a 640×360 scene thumbnail in reference layout; only scene ROIs are filled (the detector reads nothing else)."""
        if self.identity:
            return thumb
        from .scene import SCENE_ROIS, SCENE_SIZE
        scale = BASE_W / SCENE_SIZE[0]
        out = np.zeros_like(thumb)
        for roi in SCENE_ROIS.values():
            x, y, w, h = (round(v / scale) for v in roi["rect"])
            _, sy, _, sh = self.source_rect(roi["rect"], roi["anchor"])
            top, bottom = round(sy / scale), max(round((sy + sh) / scale), round(sy / scale) + 1)
            out[y:y + h, x:x + w] = cv2.resize(thumb[top:bottom, x:x + w], (w, h), interpolation=cv2.INTER_LINEAR)
        return out


def capture_rect(rect: Rect, anchor: Anchor) -> Rect:
    """Smallest rect containing `rect`'s content for every supported aspect, so the capture is independent of the game setting."""
    spans = [Layout.from_ratio(r).source_rect(rect, anchor) for r in SUPPORTED_ASPECTS.values()]
    top = math.floor(min(s[1] for s in spans))
    bottom = math.ceil(max(s[1] + s[3] for s in spans))
    return (rect[0], max(0, top), rect[2], min(BASE_H, bottom) - max(0, top))


def parse_aspect(text: str) -> Layout:
    """Accept `W:H` or a render resolution `WxH`; reject aspects the game does not offer."""
    m = re.fullmatch(r"\s*(\d+)\s*[:xX×]\s*(\d+)\s*", text or "")
    if not m or not int(m[1]) or not int(m[2]):
        raise LayoutError(f"Invalid aspect ratio: {text!r}")
    ratio = int(m[1]) / int(m[2])
    for supported in SUPPORTED_ASPECTS.values():
        if abs(ratio - supported) / supported <= ASPECT_TOLERANCE:
            return Layout.from_ratio(supported)
    raise LayoutError(f"Unsupported aspect ratio: {text!r}")


def tagged_layout(aspect: str | None) -> Layout | None:
    """Read optional video metadata; absent, invalid, or unsupported tags give None."""
    try:
        return parse_aspect(aspect or "")
    except (ValueError, OverflowError):
        return None


def recorded_layout(aspect: str | None) -> Layout:
    """Read optional video metadata; absent or invalid tags use the reference layout."""
    return tagged_layout(aspect) or Layout(1.0)
