"""單格偵測：圖示偵測（icon_detect）＋敵人名字指紋＋觀戰提示條，把一格 (banner, spec) 轉成 FrameResult（spec §5.2）。

同時放名字指紋的比對函式（same_name／fragment_of／related_name），events 與 derive 共用。"""
from __future__ import annotations

import cv2
import numpy as np

from pathlib import Path

from .icon_detect import IconDetector, IconParams
from .models import FrameResult, NameSig
from .profile import Profile

TEXT_H = 22  # 橫幅第一行文字高度（1080p，像素）：名字右界的空白判斷用

# 粉紅備援的指紋至少要有這麼高的墨密度（真名字約 0.2–0.3），避免把場景裡零星的粉橘像素當成名字。
PINK_FALLBACK_MIN_DENSITY = 0.12


def _imread_gray(path) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)


def white_mask(img_bgr: np.ndarray, white: dict) -> np.ndarray:
    """高亮度、低飽和度像素 → uint8 0/255。white＝{"v_min", "s_max"}。"""
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    ok = (hsv[..., 2] >= white["v_min"]) & (hsv[..., 1] <= white["s_max"])
    return ok.astype(np.uint8) * 255


def red_mask(img_bgr: np.ndarray, profile: Profile, pink: bool = False) -> np.ndarray:
    """R 高、G/B 低的像素 → uint8 0/255。pink=True 時另併入粉紅（綠色盲）規則，僅供名字指紋的備援使用。"""
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
    pk = profile.red.get("pink") if pink else None
    if pk:
        # 綠色盲模式敵人名字為粉紅色（約 R 220、G 152、B 163）：R 高且明顯高於 G、B 不低於 G（排除橘／膚色場景）。
        r16, g16, b16 = r.astype(np.int16), g.astype(np.int16), b.astype(np.int16)
        ok = ok | ((r16 >= pk["r_min"]) & (g16 >= pk["g_min"]) & (r16 - g16 >= pk["rg_min"]) & (b16 - g16 >= pk["bg_min"])
                   & (r16 - b16 >= pk["rb_min"]))
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


FRAGMENT_MIN_WIDTH = 30    # 殘片比對：較短指紋至少要這麼寬（再窄的殘片在別人名字上也常偶然相關）
FRAGMENT_THRESHOLD = 0.70  # 較短指紋在較長指紋上滑動的最大相關係數門檻


def fragment_of(a: NameSig | None, b: NameSig | None) -> bool:
    """一方是否為另一方被遮擋／淡出的殘片（同一敵人）：寬度差 >= 15%，且較短者在較長者上滑動的
    最大相關係數 >= FRAGMENT_THRESHOLD。寬度相近的比對交給 same_name。

    門檻依據三語言全部 fixture 的名字指紋：寬度 >= 30 的不同名字配對，滑動最大相關最高約 0.53
    （p99 0.48）；同名字裁出 40–75% 的殘片（含 4% 位元雜訊）至少 0.9。"""
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


def related_name(a: NameSig | None, b: NameSig | None, threshold: float) -> bool:
    """兩個指紋是否可能是同一敵人：同名（same_name）或其中一方是另一方的殘片。"""
    return same_name(a, b, threshold) or fragment_of(a, b)


def _segments(cols: np.ndarray) -> list[tuple[int, int]]:
    """把「該欄是否有墨」的布林陣列切成連續區段 [(起, 迄)]（含迄）。"""
    idx = np.flatnonzero(cols)
    if idx.size == 0:
        return []
    brk = np.flatnonzero(np.diff(idx) > 1)
    starts = np.concatenate(([idx[0]], idx[brk + 1]))
    ends = np.concatenate((idx[brk], [idx[-1]]))
    return list(zip(starts.tolist(), ends.tolist()))


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


def _weak_sig(sig: NameSig | None, min_density: float = 0.03) -> bool:
    """指紋為空，或墨密度低於 min_density（筆畫太細／只剩雜點，沒有鑑別力）。"""
    return sig is None or float(sig.bits.mean()) < min_density


def name_sig_from_row(row_bgr: np.ndarray, profile: Profile, pink: bool = False) -> NameSig | None:
    """從第一行裁出的列（x 範圍＝第一行左界到「+」號）取敵人名字指紋，縮放成高 16 的 0/1 字形。

    墨＝敵人名字色（紅／黃，pink=True 時併入粉紅）∪ 白字，先去掉粗亮塊與雜點；名字的範圍由敵人色欄位決定
    （第一段起、段間空白 ≤ 1.5 倍字高，更大的空白視為名字結束），再取範圍內的全部墨。
    關鍵字（白字）因此不會進入指紋，與語言無關。"""
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


def read_name_sig(row_bgr: np.ndarray, profile: Profile) -> NameSig | None:
    """名字指紋：標準規則（紅、黃）取不到像樣的字形時，備援改用粉紅（綠色盲）規則。"""
    sig = name_sig_from_row(row_bgr, profile, False)
    if _weak_sig(sig, PINK_FALLBACK_MIN_DENSITY) and "pink" in profile.red:
        alt = name_sig_from_row(row_bgr, profile, True)
        if not _weak_sig(alt, PINK_FALLBACK_MIN_DENSITY) and (sig is None or alt.bits.mean() > sig.bits.mean()):
            return alt
    return sig


# 沒有擊殺意義、但會中斷當前事件的橫幅類型（獨立消滅、小隊抹殺、REVIVE／CRATE REVEAL 等三人加分）
_OTHER_KINDS = frozenset({"elim", "squad_wipe", "score_other"})
PRODUCT_KINDS = frozenset({"knock", "assist_knock", "assist_elim"})


class Detector:
    """單格偵測器：icon_scale 由 calibrate 每支影片決定一次，之後單尺度比對（速度）。"""

    def __init__(self, profile: Profile, icon_scale: float = 1.0, params: IconParams | None = None):
        self.profile = profile
        self.icon_scale = icon_scale
        self.icons = IconDetector(Path(profile.dir), scales=(icon_scale,), params=params)
        # 觀戰樣板依白字門檻分組：同一組只算一次遮罩
        groups: dict[tuple, list[tuple[np.ndarray, float]]] = {}
        for s in profile.spectating:
            groups.setdefault((s.white["v_min"], s.white["s_max"]), []).append(
                (_imread_gray(profile.dir / s.file), s.threshold))
        self._spec_groups = [({"v_min": k[0], "s_max": k[1]}, v) for k, v in groups.items()]

    def _spectating(self, spec_bgr: np.ndarray) -> bool:
        """任一語言的觀戰樣板命中即算觀戰（見 templates/icons/PROVENANCE.md 的誤判量測）。"""
        for white, tpls in self._spec_groups:
            sm = white_mask(spec_bgr, white)
            box = _ink_box(sm)
            if any(_match(sm, t, box)[0] >= thr for t, thr in tpls):
                return True
        return False

    def _knock_sig(self, banner_bgr: np.ndarray, f) -> NameSig | None:
        """第一行（箭頭同列）、第一行左界到「+」號之間的敵人名字指紋；粉紅（綠色盲）只在標準遮罩讀不到像樣字形時備援。"""
        y0, y1 = max(0, f.chev_y - 2), min(banner_bgr.shape[0], f.chev_y + f.row_h + 2)
        x1 = f.plus_x - 3 if f.plus_x > f.line_l + 8 else f.chev_x - 4
        row = banner_bgr[y0:y1, f.line_l:max(f.line_l, x1)]
        return read_name_sig(row, self.profile)

    def detect(self, banner_bgr: np.ndarray, spec_bgr: np.ndarray) -> FrameResult:
        spectating = self._spectating(spec_bgr)
        f = self.icons.features(banner_bgr)
        p = self.icons.p
        kind = f.kind
        if kind in ("knock", "assist_knock"):
            sig = self._knock_sig(banner_bgr, f) if kind == "knock" else None
            dmg = f.line2_ink - f.line2_ink_bg >= p.line2_ink_min
            return FrameResult(kind, f.chev, f.chev_x, dmg, sig, spectating)
        if kind == "assist_elim":
            return FrameResult(kind, f.hand, f.hand_x, False, None, spectating)
        if kind in _OTHER_KINDS:
            return FrameResult(None, 0.0, 0, False, None, spectating, hint="other")
        if f.chev >= p.chev_min and f.plus >= p.plus_min:
            # 有加分箭頭與「+」，但人形不確定（淡入淡出）：不算命中，但不中斷進行中的事件
            return FrameResult(None, 0.0, 0, False, None, spectating, hint="cont")
        return FrameResult(None, 0.0, 0, False, None, spectating)
