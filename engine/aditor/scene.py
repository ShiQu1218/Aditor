"""與文字無關的場景外框比對；只供對局切分，不影響既有擊殺偵測。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import cv2
import numpy as np

SceneKind = Literal["pre_match", "lobby", "in_match_hud", "other"]
SCENE_SIZE = (640, 360)
BASE_SIZE = (1920, 1080)
# 下列座標均為 1920×1080 基準。離線先縮為 640×360，再裁局部區域。
# 每個 ROI 的 min_size 是傳輸時所需的最低像素尺寸，fps 是最低取樣頻率。
SCENE_ROIS = {
    "mode_card": {"rect": (285, 45, 210, 165), "min_size": (70, 55), "fps": 1},
    "loading_footer": {"rect": (711, 828, 498, 84), "min_size": (166, 28), "fps": 1},
    "wildcard_footer": {"rect": (711, 471, 498, 84), "min_size": (166, 28), "fps": 1},
    "ready_button": {"rect": (741, 891, 444, 165), "min_size": (148, 55), "fps": 1},
    "mode_selector": {"rect": (0, 804, 447, 255), "min_size": (149, 85), "fps": 1},
    "minimap": {"rect": (21, 21, 309, 375), "min_size": (103, 125), "fps": 1},
    "health": {"rect": (99, 873, 366, 183), "min_size": (122, 61), "fps": 1},
    "summary_tabs": {"rect": (588, 60, 750, 102), "min_size": (250, 34), "fps": 1},
}


@dataclass(frozen=True)
class SceneFrame:
    kind: SceneKind
    # 總結仍歸 other；只用正向外框恢復「錄影從上一局局尾開始」的狀態。
    match_context: bool = False
    scores: dict[str, float] = field(default_factory=dict, compare=False)
    # 全黑畫面：DDA 擷取時遊戲不在前景，錄影器改送黑幀，看不到遊戲狀態。
    blank: bool = False


# 範本的原點為 SCENE_SIZE 座標，搜尋範圍含少量座標／縮放誤差。
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
# 縮圖最亮像素不超過這個值視為全黑（容許編碼後的黑位偏移）。
BLANK_MAX_LEVEL = 8


class SceneDetector:
    def __init__(self, template_dir: Path | None = None):
        template_dir = template_dir or Path(__file__).resolve().parents[2] / "templates" / "scene"
        self._templates = {}
        for name in _TEMPLATES:
            images = []
            for suffix in ("", "_mask"):
                path = template_dir / f"{name}{suffix}.png"
                img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
                if img is None:
                    raise ValueError(f"場景範本無法讀取：{path}")
                images.append(img)
            self._templates[name] = tuple(images)

    def classify(self, frame: np.ndarray) -> SceneFrame:
        """輸入 uint8 BGR 或灰階全畫面；尺寸不足時拒絕，避免假性升頻。"""
        if frame.dtype != np.uint8 or frame.ndim not in (2, 3):
            raise ValueError("場景影格必須為 uint8 BGR 或灰階")
        if frame.ndim == 3:
            if frame.shape[2] != 3:
                raise ValueError("場景影格必須為三通道 BGR")
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h, w = frame.shape
        if w < SCENE_SIZE[0] or h < SCENE_SIZE[1]:
            raise ValueError("目前場景設定至少需要 640×360；請提供場景 ROI 或較大的全畫面")
        gray = cv2.resize(frame, SCENE_SIZE, interpolation=cv2.INTER_AREA)
        scores = {}
        for name, (roi, _) in _TEMPLATES.items():
            x, y, rw, rh = roi
            template, mask = self._templates[name]
            result = cv2.matchTemplate(gray[y:y + rh, x:x + rw], template,
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
