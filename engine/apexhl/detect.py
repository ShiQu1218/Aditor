"""單格偵測：以範本比對把一格 (banner, spec) 轉成 FrameResult（spec §5.2）。"""
from __future__ import annotations

import cv2
import numpy as np

from .models import FrameResult, NameSig
from .profile import Profile

_ROW_PAD = 6  # 關鍵字所在列上下容許的偏移（像素）
# 第一行關鍵字在 banner 內的垂直搜尋帶（spec §3：提示不堆疊，第一行位置固定，範本頂端 y=66）。
# 只限制搜尋範圍以加速，上下各留約 16 px 容許。
_LINE1_ROWS = (50, 108)
_DAMAGE_DEPTH = 40  # 傷害行搜尋：第一行下緣往下多少列


def _imread_gray(path) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)


def white_mask(img_bgr: np.ndarray, profile: Profile) -> np.ndarray:
    """高亮度、低飽和度像素 → uint8 0/255。"""
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    ok = (hsv[..., 2] >= profile.white["v_min"]) & (hsv[..., 1] <= profile.white["s_max"])
    return ok.astype(np.uint8) * 255


def red_mask(img_bgr: np.ndarray, profile: Profile) -> np.ndarray:
    """R 高、G/B 低的像素 → uint8 0/255。"""
    b, g, r = img_bgr[..., 0], img_bgr[..., 1], img_bgr[..., 2]
    ok = (r >= profile.red["r_min"]) & (g <= profile.red["g_max"]) & (b <= profile.red["b_max"])
    return ok.astype(np.uint8) * 255


def name_sig_similarity(a: NameSig, b: NameSig) -> float:
    """兩個名字指紋的相關係數（-1..1）。寬度不同時把 b 縮放到 a 的寬度再比。"""
    ba = a.bits.astype(np.float32)
    bb = b.bits.astype(np.float32)
    if bb.shape[1] != ba.shape[1]:
        bb = cv2.resize(bb, (ba.shape[1], ba.shape[0]), interpolation=cv2.INTER_AREA)
    # 輕微模糊：容許 1 px 的筆畫錯位（紅、白字邊緣與縮放取樣不同）
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
    """遮罩中有像素的外框 (x0, y0, x1, y1)，外加 pad；全黑時回傳空框。純加速用。
    rows_limit 先把列範圍限制在 [y0, y1)。"""
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


def _match(mask: np.ndarray, tpl: np.ndarray, box=None) -> tuple[float, int, int]:
    """回傳 (最高分, x, y)，座標為 mask 座標。box 限定搜尋範圍；範圍比範本小視為無命中。"""
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


class Detector:
    def __init__(self, profile: Profile, h_scale: float = 1.0):
        self.profile = profile
        self.h_scale = h_scale
        self.tpl = {k: _imread_gray(profile.dir / v.file) for k, v in profile.keywords.items()}
        self.thr = {k: v.threshold for k, v in profile.keywords.items()}
        self.spec_tpl = [(_imread_gray(profile.dir / v.file), v.threshold) for v in profile.spec_templates]

    # ---- 內部 ----
    def _scaled(self, banner_bgr: np.ndarray, scale: float) -> np.ndarray:
        if abs(scale - 1.0) < 1e-6:
            return banner_bgr
        w = max(1, int(round(banner_bgr.shape[1] * scale)))
        return cv2.resize(banner_bgr, (w, banner_bgr.shape[0]), interpolation=cv2.INTER_LINEAR)

    def keyword_scores(self, banner_bgr: np.ndarray) -> dict[str, float]:
        """每個關鍵字在整個 banner 上的最高分（診斷／測試用，不做否決與早退）。"""
        wm = white_mask(self._scaled(banner_bgr, self.h_scale), self.profile)
        return {k: self._score(wm, k) for k in self.tpl}

    def best_scale_score(self, banner_bgr: np.ndarray, scale: float) -> float:
        """該水平比例下所有關鍵字的最高分（給 calibrate 用）。"""
        wm = white_mask(self._scaled(banner_bgr, scale), self.profile)
        return max(self._score(wm, k) for k in self.tpl)

    def _score(self, wm: np.ndarray, key: str) -> float:
        rows = _LINE1_ROWS if key != "damage" else (_LINE1_ROWS[0], _LINE1_ROWS[1] + _DAMAGE_DEPTH)
        return _match(wm, self.tpl[key], _ink_box(wm, rows_limit=rows))[0]

    def _hit(self, wm: np.ndarray, key: str, box):
        s, x, y = _match(wm, self.tpl[key], box)
        return (s, x, y) if s >= self.thr[key] else None

    def _spectating(self, spec_bgr: np.ndarray) -> bool:
        sm = white_mask(spec_bgr, self.profile)
        box = _ink_box(sm)
        return any(_match(sm, t, box)[0] >= thr for t, thr in self.spec_tpl)

    @staticmethod
    def _segments(cols: np.ndarray) -> list[tuple[int, int]]:
        """把「該欄是否有墨」的布林陣列切成連續區段 [(起, 迄)]（含迄）。"""
        idx = np.flatnonzero(cols)
        if idx.size == 0:
            return []
        brk = np.flatnonzero(np.diff(idx) > 1)
        starts = np.concatenate(([idx[0]], idx[brk + 1]))
        ends = np.concatenate((idx[brk], [idx[-1]]))
        return list(zip(starts.tolist(), ends.tolist()))

    @staticmethod
    def _is_plus(block: np.ndarray) -> bool:
        """block（一個連續欄區段的墨）是否為「+」符號：小、近正方形、十字形。"""
        rows = np.flatnonzero(block.any(axis=1))
        h, w = rows[-1] - rows[0] + 1, block.shape[1]
        if not (6 <= w <= 14 and abs(h - w) <= 3):
            return False
        b = block[rows[0]:rows[-1] + 1]
        t = max(1, min(h, w) // 3)
        corners = (b[:t, :t].mean() + b[:t, -t:].mean() + b[-t:, :t].mean() + b[-t:, -t:].mean()) / 4
        cy, cx = h // 2, w // 2
        bar_h = b[max(0, cy - 1):cy + 2].any(axis=0).mean()
        bar_v = b[:, max(0, cx - 1):cx + 2].any(axis=1).mean()
        return corners < 0.15 and bar_h > 0.8 and bar_v > 0.8

    @staticmethod
    def _despeckle(ink: np.ndarray, min_area: int = 3) -> np.ndarray:
        """去掉不像字形筆畫的墨：粗亮塊（火光、反光，筆畫寬 < 5 px 故用 5x5 開運算偵測）、
        孤立雜點與細長線條（橫線、稀疏斜線）。"""
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

    def _name_sig(self, banner: np.ndarray, wm: np.ndarray, x0: int, y: int, h: int,
                  red_name: bool) -> NameSig | None:
        """取關鍵字右緣 x0 起、同一行的名字區塊，縮放成高 16 的 0/1 字形指紋。

        墨一律取 white_mask ∪ red_mask（紅、白字可跨類型比對），先去掉粗亮塊與雜點；
        名字右緣由「超過 1.5×字高的空白」或十字形的「+」符號（擊倒後面的 +N 分數，僅
        紅字名以外的助攻也會遇到）決定。垂直方向取關鍵字同一行（高 h）後再裁到墨的上下緣。
        """
        H, W = wm.shape
        y0, y1 = max(0, y), min(H, y + h)
        if x0 >= W or y1 <= y0:
            return None
        red = red_mask(banner[y0:y1, x0:], self.profile) > 0
        ink = self._despeckle((wm[y0:y1, x0:] > 0) | red)
        red = red & ink
        max_gap = 1.5 * h
        segs = self._segments((red if red_name else ink).any(axis=0))
        if not segs:
            return None
        start, end = segs[0][0], segs[0][1]
        for c0, c1 in segs[1:]:
            if c0 - end - 1 > max_gap:
                break
            if not red_name and c0 - end - 1 >= 3 and self._is_plus(ink[:, c0:c1 + 1]):
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

    # ---- 對外 ----
    def detect(self, banner_bgr: np.ndarray, spec_bgr: np.ndarray) -> FrameResult:
        spectating = self._spectating(spec_bgr)
        banner = self._scaled(banner_bgr, self.h_scale)
        wm = white_mask(banner, self.profile)
        box = _ink_box(wm, rows_limit=_LINE1_ROWS)

        def result(kind, score=0.0, x=0, damage=False, sig=None):
            return FrameResult(kind, score, x, damage, sig, spectating)

        # 「敵方小隊已消滅」不是事件，須否決。為省時間改成「任何關鍵字命中後、回傳前」才檢查，
        # 輸出與「先檢查否決」完全相同（否決範本沒命中時不影響任何結果）。
        def vetoed() -> bool:
            return self._hit(wm, "enemy_squad_down", box) is not None

        h = self.tpl["knock"].shape[0]
        hit = self._hit(wm, "squad_wipe", box)
        if hit:
            if vetoed():
                return result(None)
            return result("squad_wipe", hit[0], hit[1])

        hit = self._hit(wm, "assist", box)
        if hit:
            if vetoed():
                return result(None)
            s, x, y = hit
            rx = x + self.tpl["assist"].shape[1] // 2  # 右側搜尋區從助攻範本中段起，容許間距
            lo, hi = max(0, y - _ROW_PAD), y + h + _ROW_PAD
            sub = wm[lo:hi, rx:]
            best = None
            for key in ("knock", "elim"):
                sc, sx, sy = _match(sub, self.tpl[key])
                if sc >= self.thr[key] and (best is None or sc > best[0]):
                    best = (sc, key, rx + sx, lo + sy)
            if best is None:
                kind, edge, ky = "assist_elim", x + self.tpl["assist"].shape[1], y
            else:
                kind = "assist_knock" if best[1] == "knock" else "assist_elim"
                edge, ky = best[2] + self.tpl[best[1]].shape[1], best[3]
            return result(kind, s, x, False, self._name_sig(banner, wm, edge, ky, h, False))

        hit = self._hit(wm, "knock", box)
        if hit:
            if vetoed():
                return result(None)
            s, x, y = hit
            dmg = _match(wm, self.tpl["damage"], (box[0], y + h, box[2], min(wm.shape[0], y + h + _DAMAGE_DEPTH)))[0] >= self.thr["damage"]
            sig = self._name_sig(banner, wm, x + self.tpl["knock"].shape[1], y, h, True)
            return result("knock", s, x, dmg, sig)

        hit = self._hit(wm, "elim_done", box)
        if hit:
            if vetoed():
                return result(None)
            s, x, y = hit
            sig = self._name_sig(banner, wm, x + self.tpl["elim_done"].shape[1], y, h, True)
            return result("elim", s, x, False, sig)

        return result(None)
