"""圖示優先、與語言無關的擊殺橫幅逐格偵測（事件偵測的唯一路徑；上層見 detect.Detector）。

橫幅上與語言無關的圖示（樣板見 templates/icons/，只從訓練素材 English.mkv／Japanese.mkv 裁切、平均）：
- chev   ：分數右側的三層箭頭（「+N」分數圖示的左半；所有加分橫幅都有，含 REVIVE／CRATE REVEAL／敵方小隊已消滅）
- person ：箭頭右側的單人圖示（個人擊殺分：擊倒、助攻擊倒、敵方小隊已消滅）
- group  ：箭頭右側的三人圖示（小隊分：小隊抹殺、REVIVE、CRATE REVEAL…）
- skull  ：第一行左側＝獨立擊殺；小隊抹殺第二行也有
- hand   ：第一行左側＝助攻消滅；小隊抹殺第二行也有（助攻擊殺的隊友）

除了圖示，另用兩個與語言無關的版面線索：
- line2_ink ：第一行下方是否有第二行文字（擊倒的傷害行、小隊抹殺的名單）；以白色頂帽（細亮筆畫）像素比例量測
- name_color：第一行是否有敵人色（紅／黃／粉紅）文字；擊倒與獨立擊殺的敵人名字是敵人色，助攻與非事件橫幅是白字

逐格輸出 IconFrame（特徵＋分類）；事件層（連續格聚成事件、名字切分）在 events.EventTracker。分類規則與門檻在 IconParams；
每個數值由哪份訓練資料決定、驗收結果與已知失敗模式，見 .superpowers/sdd/icon-detect-report.md（實驗報告）。
產品範圍只需要 knock 與 assist（assist_knock＋assist_elim）；elim／squad_wipe 只當反例。
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path

import cv2
import numpy as np

ICON_NAMES = ("chev", "person", "group", "skull", "hand", "plus")
ROW0, ROW1 = 30, 150          # 搜尋帶（banner 座標）：涵蓋第一行 y≈60–110 與第二行
DEFAULT_SCALES = (0.9, 0.95, 1.0, 1.05, 1.1)


@dataclass
class IconParams:
    """分類門檻；預設值皆由訓練素材（English.mkv／Japanese.mkv／SC1.mkv）量測決定，驗收片沒有調參。"""
    chev_min: float = 0.75       # 箭頭分數門檻
    plus_min: float = 0.70       # 箭頭左側「+」號門檻（擋掉大廳小隊卡片上「0 ⇑人」之類沒有 + 的分數圖示）
    fig_min: float = 0.60        # 單人／三人圖示的最低分
    fig_lead: float = 0.10       # 單人與三人圖示的分數差至少要這麼多才判定
    left_min: float = 0.85       # 第一行左側骷髏／握手門檻
    line2_icon_min: float = 0.65  # 第二行骷髏／握手（小隊抹殺名單）門檻
    line2_ink_min: float = 0.05  # 第二行細筆畫比例（扣背景參考帶後）門檻＝有第二行（傷害行）
    name_color_min: int = 60     # 第一行敵人色像素數（扣背景參考帶後）門檻
    left_above_max: float = 0.70  # 左側圖示上方一行若有箭頭（≥此分數）→ 它其實是第二行圖示


@dataclass
class IconFrame:
    kind: str | None = None          # knock / assist_knock / elim / assist_elim / squad_wipe / score_other / None
    chev: float = 0.0
    chev_x: int = 0
    chev_y: int = 0
    chev_scale: float = 1.0
    plus: float = 0.0                # 箭頭左側（分數數字前）的「+」號
    person: float = 0.0
    group: float = 0.0
    skull: float = 0.0               # 第一行（或無箭頭時整帶）最佳骷髏
    skull_x: int = 0
    skull_y: int = 0
    hand: float = 0.0
    hand_x: int = 0
    hand_y: int = 0
    left_above: float = 0.0          # 左側圖示上方一行的箭頭分數（判斷是否為第二行）
    line2_icons: int = 0             # 箭頭下方一行的骷髏／握手個數
    line2_ink: float = 0.0
    name_color: int = 0
    line2_ink_bg: float = 0.0        # 背景參考帶（第一行正上方）的細筆畫比例
    plus_x: int = 0                  # 「+」號左緣（banner 座標）：名字右界
    line_l: int = 0                  # 第一行左界（banner 座標，由箭頭右緣對稱推得）
    row_h: int = 0                   # 箭頭（＝第一行文字列）高度
    name_color_bg: int = 0           # 背景參考帶的敵人色像素數（換算成與第一行同高）

    def to_dict(self) -> dict:
        return asdict(self)


def _read_gray(path: Path) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f"圖示樣板無法解碼：{path}")
    return img


def _rs(t: np.ndarray, s: float) -> np.ndarray:
    if abs(s - 1.0) < 1e-6:
        return t
    return cv2.resize(t, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)


def enemy_color_mask(bgr: np.ndarray) -> np.ndarray:
    """敵人名字色（紅／黃／粉紅；三種色盲模式）遮罩，與語言無關。數值同 templates/*/profile.json 的 red（含 yellow、pink）。"""
    b, g, r = (bgr[..., i].astype(np.int16) for i in range(3))
    red = (r >= 185) & (g <= 185) & (b <= 185) & (r - np.maximum(g, b) >= 50)
    yellow = (r >= 160) & (g >= 150) & (b <= 110) & (r - b >= 90) & (np.abs(r - g) <= 30)
    pink = (r >= 170) & (g >= 100) & (r - g >= 40) & (b - g >= -12) & (r - b >= 20)
    return red | yellow | pink


def is_knock(f: IconFrame, p: IconParams) -> bool:
    """單人加分橫幅是否為擊倒：第一行有敵人色名字，或有第二行（傷害行）；皆以「扣掉背景參考帶」後的淨值判斷。"""
    return (f.name_color - f.name_color_bg >= p.name_color_min
            or f.line2_ink - f.line2_ink_bg >= p.line2_ink_min)


class IconDetector:
    def __init__(self, tpl_dir: Path, scales=DEFAULT_SCALES, params: IconParams | None = None,
                 diag: bool = False):
        """diag=True：有箭頭時也計算左側圖示特徵（離線分析門檻用，較慢；分類結果不變）。"""
        self.scales = tuple(scales)
        self.p = params or IconParams()
        self.diag = diag
        base = {k: _read_gray(Path(tpl_dir) / f"{k}.png") for k in ICON_NAMES}
        self.base = base
        self.tpl = {k: {s: _rs(t, s) for s in self.scales} for k, t in base.items()}
        self._k = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))

    # ---- 比對 ----
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
        """g 內 key 圖示（尺度 s）超過 thr 的個數（非極大值抑制：同一圖示寬度內只算一個）。"""
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

    # ---- 對外 ----
    def features(self, banner_bgr: np.ndarray) -> IconFrame:
        p = self.p
        band = np.ascontiguousarray(banner_bgr[ROW0:ROW1])
        g = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
        f = IconFrame()
        cs, cx, cy, sc = self._best(g, "chev")
        f.chev, f.chev_x, f.chev_y, f.chev_scale = cs, cx, cy + ROW0, sc
        ch = self.tpl["chev"][sc].shape
        if cs >= p.chev_min:
            # 箭頭右側：單人／三人圖示（同尺度附近）
            near = tuple(s for s in self.scales if abs(s - sc) <= 0.051)
            x0, y0 = cx + ch[1] - 6, max(0, cy - 8)
            sub = g[y0:y0 + ch[0] + 16, x0:x0 + int(48 * sc)]
            f.person = self._best(sub, "person", near)[0]
            f.group = self._best(sub, "group", near)[0]
            # 「+N」的加號：在箭頭左側 15–110 px、同列（數字 1–4 位）
            px0 = max(0, cx - int(110 * sc))
            f.plus, plx, _, _ = self._best(
                g[max(0, cy - 4):cy + ch[0] + 4, px0:max(px0 + 1, cx - int(12 * sc))], "plus", near)
            f.plus_x = px0 + plx
            f.row_h = ch[0]
            # 箭頭下方一行：小隊抹殺名單的骷髏／握手個數，與第二行細筆畫比例
            l2y0, l2y1 = cy + int(0.75 * ch[0]), min(g.shape[0], cy + int(2.1 * ch[0]))
            l2 = g[l2y0:l2y1]
            s_icon = min(self.scales, key=lambda s: abs(s - sc))
            f.line2_icons = self._peaks(l2, "skull", s_icon, p.line2_icon_min) + \
                self._peaks(l2, "hand", s_icon, p.line2_icon_min)
            # 橫幅整塊置中（banner 中心 x=400）：第一行的右界≈人形右緣 R，左界≈800−R。
            # 第二行（傷害行）也置中且較短，只看中央 [400−w/4, 400+w/4]（w＝第一行寬），減少背景干擾。
            R = min(g.shape[1], cx + ch[1] + int(24 * sc))
            L = max(0, g.shape[1] - R)
            f.line_l = L
            q = max(20, (R - L) // 4)
            xa, xb = max(0, 400 - q), min(g.shape[1], 400 + q)
            th = cv2.morphologyEx(l2, cv2.MORPH_TOPHAT, self._k)[:, xa:xb]
            f.line2_ink = float((th >= 60).mean()) if th.size else 0.0
            # 第一行（箭頭同列、第一行左界到箭頭左側）的敵人色像素
            row = band[max(0, cy - 2):cy + ch[0] + 2, L:max(L, cx - 4)]
            f.name_color = int(enemy_color_mask(row).sum())
            # 背景參考帶：第一行正上方、同高度（橫幅底板只蓋到文字行；上方是純背景）。
            # 草地／黃色場景會同時讓第一行與參考帶的「敵人色」「細筆畫」變多，所以分類用差值。
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
        # 沒有加分箭頭：找第一行左側的骷髏／握手（整帶搜尋）
        ss, sx, sy, sk_s = self._best(g, "skull")
        hs, hx, hy, hd_s = self._best(g, "hand")
        f.skull, f.skull_x, f.skull_y = ss, sx, sy + ROW0
        f.hand, f.hand_x, f.hand_y = hs, hx, hy + ROW0
        if max(ss, hs) >= p.left_min:
            # 圖示右側同列的敵人色，以及上一行是否有箭頭（＝它是小隊抹殺第二行的名單圖示）
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
        """依圖示與版面線索分類。score_other＝有加分圖示但不是擊殺（REVIVE、CRATE REVEAL 等三人圖示）。"""
        p = self.p
        if f.chev >= p.chev_min:
            if f.plus < p.plus_min:
                return None
            fig = None
            if max(f.person, f.group) >= p.fig_min and abs(f.person - f.group) >= p.fig_lead:
                fig = "person" if f.person > f.group else "group"
            if fig == "group":  # 小隊分：小隊抹殺（第二行有名單圖示）或 REVIVE／CRATE REVEAL 等
                return "squad_wipe" if f.line2_icons >= 1 else "score_other"
            if fig == "person":  # 個人擊殺分：擊倒（敵人色名字或傷害行）／助攻擊倒（白字、單行）
                return "knock" if is_knock(f, p) else "assist_knock"
            return "squad_wipe" if f.line2_icons >= 1 else None
        left = max(f.skull, f.hand)
        if left >= p.left_min and f.left_above < p.left_above_max:
            return "elim" if f.skull >= f.hand else "assist_elim"
        return None

    def chev_best(self, banner_bgr: np.ndarray) -> tuple[float, float]:
        """整個橫幅帶上箭頭的最佳 (分數, 尺度)；校準用（便宜：只比對箭頭一張樣板）。"""
        g = cv2.cvtColor(np.ascontiguousarray(banner_bgr[ROW0:ROW1]), cv2.COLOR_BGR2GRAY)
        s, _, _, sc = self._best(g, "chev")
        return s, sc

    def maybe_banner(self, banner_bgr: np.ndarray) -> bool:
        """便宜的初篩（箭頭或握手有跡象）：學習錨點時只對這些格做完整特徵計算。"""
        g = cv2.cvtColor(np.ascontiguousarray(banner_bgr[ROW0:ROW1]), cv2.COLOR_BGR2GRAY)
        if self._best(g, "chev")[0] >= 0.6:
            return True
        return self._best(g, "hand")[0] >= 0.85
