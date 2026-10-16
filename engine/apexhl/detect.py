"""單格偵測：以範本比對把一格 (banner, spec) 轉成 FrameResult（spec §5.2）。"""
from __future__ import annotations

import cv2
import numpy as np

from .models import FrameResult, NameSig
from .profile import Profile

_ROW_PAD = 6  # 關鍵字所在列上下容許的偏移（像素）

# 助攻之後的子關鍵字（擊倒／消滅）：兩者都沒過各自門檻時的相對判定。
# 依據三語言所有助攻 fixture：錯誤子關鍵字最高 0.36、正確子關鍵字最低 0.80（test_assist_sub_floor_and_lead_sit_inside_fixture_gap）。
# 低對比錄影（壓縮、縮放）下正確者會落在門檻略下，錯誤者仍只有 ~0.25–0.35，因此用「贏家夠強且領先夠多」判定。
ASSIST_SUB_FLOOR = 0.45
ASSIST_SUB_LEAD = 0.25


def pick_assist_sub(scores: dict[str, float], thr: dict[str, float]) -> str | None:
    """scores／thr 的鍵為 "knock"、"elim"。回傳助攻之後的類型（"knock"／"elim"）或 None（無法判斷）。

    有關鍵字過自己門檻 → 與舊行為相同（過門檻者中分數最高）；都沒過 → 相對判定：
    贏家 ≥ ASSIST_SUB_FLOOR 且領先另一個 ≥ ASSIST_SUB_LEAD。"""
    passing = [k for k in scores if scores[k] >= thr[k]]
    if passing:
        return max(passing, key=lambda k: scores[k])
    ranked = sorted(scores, key=lambda k: scores[k], reverse=True)
    if len(ranked) < 2:
        return None
    win, other = ranked[0], ranked[1]
    if scores[win] >= ASSIST_SUB_FLOOR and scores[win] - scores[other] >= ASSIST_SUB_LEAD:
        return win
    return None


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
    if "r_diff_min" in profile.red:
        ok = ok & (r.astype(np.int16) - np.maximum(g, b).astype(np.int16) >= profile.red["r_diff_min"])
    y = profile.red.get("yellow")
    if y:
        # 色盲模式（紅色盲／藍色盲）敵人名字為黃色：R、G 高且接近、B 低。未設定時（zh-TW）行為不變。
        r16, g16, b16 = r.astype(np.int16), g.astype(np.int16), b.astype(np.int16)
        ok = ok | ((r16 >= y["r_min"]) & (g16 >= y["g_min"]) & (b16 <= y["b_max"])
                   & (r16 - b16 >= y["rb_min"]) & (np.abs(r16 - g16) <= y["rg_max"]))
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


def same_name(a: NameSig | None, b: NameSig | None, threshold: float) -> bool:
    """兩個名字指紋是否屬於同一敵人：任一為 None → False；寬度比差 ≥ 15% → False；
    否則相關係數 ≥ threshold（profile.name_sig_threshold）。"""
    if a is None or b is None:
        return False
    if abs(a.width - b.width) / max(a.width, b.width) >= 0.15:
        return False
    return name_sig_similarity(a, b) >= threshold


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
        # 診斷／校準只看關鍵字範本；skull 只是名字的左界與「獨立擊殺」存在檢查
        self._kw_keys = [k for k in self.tpl if k != "skull"]
        # spec_templates 可為空（該語言不支援觀戰偵測）→ 永遠回報 spectating=False
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
        return {k: self._score(wm, k) for k in self._kw_keys}

    def best_scale_score(self, banner_bgr: np.ndarray, scale: float) -> float:
        """該水平比例下所有關鍵字的最高分（給 calibrate 用）。"""
        wm = white_mask(self._scaled(banner_bgr, scale), self.profile)
        return max(self._score(wm, k) for k in self._kw_keys)

    def _score(self, wm: np.ndarray, key: str) -> float:
        r0, r1 = self.profile.line1_rows
        rows = (r0, r1) if key != "damage" else (r0, r1 + self.profile.damage_depth)
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
        x_end = W
        if x0 >= x_end or y1 <= y0:
            return None
        red = red_mask(banner[y0:y1, x0:x_end], self.profile) > 0
        ink = self._despeckle((wm[y0:y1, x0:x_end] > 0) | red)
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

    def _name_sig_bounded(self, banner: np.ndarray, wm: np.ndarray, x0: int, x1: int, y: int,
                          h: int) -> NameSig | None:
        """取 [x0, x1) 之間、關鍵字同一行的所有墨當作名字（name_side=left 用：左界是骷髏圖示、
        右界是關鍵字，兩端都由範本比對決定，不靠「空白多寬」猜測）。"""
        H, W = wm.shape
        y0, y1 = max(0, y), min(H, y + h)
        x0, x1 = max(0, x0), min(W, x1)
        if x1 - x0 < 4 or y1 <= y0:
            return None
        red = red_mask(banner[y0:y1, x0:x1], self.profile) > 0
        ink = self._despeckle((wm[y0:y1, x0:x1] > 0) | red)
        cols = np.flatnonzero(ink.any(axis=0))
        if cols.size == 0:
            return None
        block = ink[:, cols[0]:cols[-1] + 1]
        rows = np.flatnonzero(block.any(axis=1))
        block = block[rows[0]:rows[-1] + 1].astype(np.float32)
        bh, bw = block.shape
        if bw < 4:
            return None
        w16 = max(1, int(round(bw * NameSig.HEIGHT / bh)))
        small = cv2.resize(block, (w16, NameSig.HEIGHT), interpolation=cv2.INTER_AREA)
        return NameSig(w16, (small >= 0.5).astype(np.uint8))

    def _skull_left_of(self, wm: np.ndarray, x_kw: int, y: int, h: int) -> tuple[float, int, int] | None:
        """在關鍵字左側、同一行找骷髏圖示；回傳 (分數, x, y) 或 None（分數低於門檻）。"""
        tpl = self.tpl["skull"]
        lo, hi = max(0, y - _ROW_PAD), y + h + _ROW_PAD
        sub = wm[lo:hi, :max(0, x_kw)]
        s, sx, sy = _match(sub, tpl)
        if s < self.thr["skull"]:
            return None
        return s, sx, lo + sy

    # ---- 對外 ----
    def detect(self, banner_bgr: np.ndarray, spec_bgr: np.ndarray) -> FrameResult:
        spectating = self._spectating(spec_bgr)
        banner = self._scaled(banner_bgr, self.h_scale)
        wm = white_mask(banner, self.profile)
        box = _ink_box(wm, rows_limit=self.profile.line1_rows)

        def result(kind, score=0.0, x=0, damage=False, sig=None):
            return FrameResult(kind, score, x, damage, sig, spectating)

        # 「敵方小隊已消滅」不是事件，須否決。為省時間改成「任何關鍵字命中後、回傳前」才檢查，
        # 輸出與「先檢查否決」完全相同（否決範本沒命中時不影響任何結果）。
        def vetoed() -> bool:
            if "enemy_squad_down" not in self.tpl:  # 該語言沒有真實樣本的否決橫幅：不否決
                return False
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
            assist_end = x + self.tpl["assist"].shape[1]
            rx = x + self.tpl["assist"].shape[1] // 2  # 右側搜尋區從助攻範本中段起，容許間距
            lo, hi = max(0, y - _ROW_PAD), y + h + _ROW_PAD
            sub = wm[lo:hi, rx:]
            knock_key = "assist_knock" if "assist_knock" in self.tpl else "knock"
            keys = {"knock": knock_key, "elim": "elim"}
            found = {c: _match(sub, self.tpl[k]) for c, k in keys.items()}
            pick = pick_assist_sub({c: m[0] for c, m in found.items()},
                                   {c: self.thr[k] for c, k in keys.items()})
            best = None if pick is None else (found[pick][0], pick, rx + found[pick][1],
                                              lo + found[pick][2], keys[pick])
            if best is None:
                kind, edge, ky = "assist_elim", assist_end, y
            else:
                kind = "assist_knock" if best[1] == "knock" else "assist_elim"
                if self.profile.name_between_assist:
                    # ja：アシスト、<名字>をダウン —— 名字夾在兩者之間（單字名也只取到關鍵字左緣，
                    # 不會把關鍵字後面的「+100」當名字）
                    return result(kind, s, x, False,
                                  self._name_sig_bounded(banner, wm, assist_end, best[2], y, h))
                edge, ky = best[2] + self.tpl[best[4]].shape[1], best[3]
            return result(kind, s, x, False, self._name_sig(banner, wm, edge, ky, h, False))

        hit = self._hit(wm, "knock", box)
        if hit:
            if vetoed():
                return result(None)
            s, x, y = hit
            dmg = _match(wm, self.tpl["damage"], (box[0], y + h, box[2], min(wm.shape[0], y + h + self.profile.damage_depth)))[0] >= self.thr["damage"]
            sig = self._name_sig(banner, wm, x + self.tpl["knock"].shape[1], y, h, True)
            return result("knock", s, x, dmg, sig)

        hit = self._hit(wm, "elim_done", box)
        if hit:
            if vetoed():
                return result(None)
            s, x, y = hit
            if self.profile.name_side == "left":
                # ja：[骷髏] 名字 を撃破。骷髏是「真的獨立擊殺」的存在檢查，也是名字的左界
                sk = self._skull_left_of(wm, x, y, h)
                if sk is None:
                    return result(None)
                sig = self._name_sig_bounded(banner, wm, sk[1] + self.tpl["skull"].shape[1], x, y, h)
                return result("elim", s, x, False, sig)
            sig = self._name_sig(banner, wm, x + self.tpl["elim_done"].shape[1], y, h, True)
            return result("elim", s, x, False, sig)

        return result(None)
