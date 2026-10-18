"""單格偵測：圖示偵測（icon_detect）＋敵人名字指紋＋觀戰提示條，把一格 (banner, spec) 轉成 FrameResult（spec §5.2）。

同時放名字指紋的比對函式（same_name／fragment_of），events 與 derive 共用。"""
from __future__ import annotations

import base64
from dataclasses import dataclass

import cv2
import numpy as np

from pathlib import Path

from .icon_detect import IconDetector, IconFrame, IconParams
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


# ---- 每支影片自學的「擊殺關鍵字」樣板（與語言無關的驗證） ----
# 單人加分圖示也用在許多非擊殺橫幅（弱者獎勵、旗幟取回、敵方小隊已消滅、安全區、進化球…，分數數字甚至與助攻相同），
# 圖示與分數都分不開，只有橫幅文字不同。文字隨語言不同，所以不用預先做好的文字樣板，而是**從這支影片自己學**：
# - 助攻前綴：助攻消滅橫幅（握手圖示很可靠）握手右側的前幾個字（「助攻，」「ASSIST,」「アシスト、」），
#   助攻擊倒橫幅的行首是同一段字（沒有握手）。
# - 擊倒關鍵字：擊倒橫幅（敵人色名字＋傷害行，很可靠）名字左側的字（「擊倒」「KNOCKED DOWN」），
#   助攻擊倒橫幅在名字前也是同一個字（日文的助攻擊倒不是，靠助攻前綴）。
# 候選橫幅的第一行白字遮罩與樣板的最大正規化相關 ≥ KW_THRESHOLD 才算擊殺橫幅。
KW_THRESHOLD = 0.7      # 開發集 H950：真橫幅畫格 25 百分位 0.93（10 百分位 0.6–0.66）、非擊殺橫幅 99 百分位 0.62–0.68
PREFIX_W = 64           # 助攻前綴樣板寬（像素，已是校準後尺度）
KEYWORD_W = 36          # 擊倒關鍵字樣板寬（名字左側）
KW_MIN_INK = 0.04       # 樣板的筆畫比例下限（避免全空樣板）


INK_SCALE = 100.0       # 頂帽亮度差到這個值就算滿分的筆畫（0–1 連續值）
_INK_K = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))


def ink_mask(bgr: np.ndarray, profile: Profile) -> np.ndarray:
    """關鍵字樣板用的文字筆畫圖（0–1 連續值）：局部頂帽（細亮筆畫相對於局部背景的亮度差）。
    不用絕對白色門檻：低對比錄影（驗收片 test-TC 的文字偏灰，舊文字法在上面也只有 0.49–0.60 的分數）會漏字，
    亮背景（雪地、天空、沙地）會混入背景塊。連續值而不是二值化：二值化的文字樣圖樣彼此相關偏高
    （開發集 H950 非擊殺橫幅誤接受 40–75%），連續值加較高門檻（KW_THRESHOLD）則誤接受 < 1%。"""
    g = cv2.cvtColor(np.ascontiguousarray(bgr), cv2.COLOR_BGR2GRAY)
    th = cv2.morphologyEx(g, cv2.MORPH_TOPHAT, _INK_K).astype(np.float32)
    return np.clip(th / INK_SCALE, 0.0, 1.0)


def _match_max(mask: np.ndarray, tpl: np.ndarray) -> float:
    if mask.ndim < 2 or mask.shape[0] < tpl.shape[0] or mask.shape[1] < tpl.shape[1]:
        return 0.0
    res = cv2.matchTemplate(mask.astype(np.float32), tpl, cv2.TM_CCOEFF_NORMED)
    res = np.nan_to_num(res, nan=0.0, posinf=0.0, neginf=0.0)
    return float(res.max()) if res.size else 0.0


MIN_ANCHOR_BANNERS = 3  # 至少要來自 3 個不同橫幅：同一個橫幅的連續畫格背景幾乎相同，只有跨橫幅才能多數決掉亮背景


def _consensus(strips: list[np.ndarray], banners: int | None = None) -> np.ndarray | None:
    """多個錨點的墨遮罩取多數決；錨點橫幅少於 MIN_ANCHOR_BANNERS 個（banners 未給時以錨點數計）
    或樣板幾乎沒有墨 → None（不啟用該樣板）。"""
    if (len(strips) if banners is None else banners) < MIN_ANCHOR_BANNERS:
        return None
    tpl = np.mean(strips, axis=0).astype(np.float32)   # 跨橫幅平均：每個橫幅不同的背景被平均掉，只剩共同的字
    return tpl if float((tpl > 0.3).mean()) >= KW_MIN_INK else None


class Keywords:
    """每支影片學到的兩個樣板（None＝沒有足夠錨點，該樣板不啟用）。"""

    def __init__(self, assist: np.ndarray | None = None, knock: np.ndarray | None = None,
                 assist_by_knock: bool = False):
        self.assist, self.knock = assist, knock
        # 這支影片的助攻擊倒橫幅是否含擊倒關鍵字（繁中「助攻，擊倒」、英文「ASSIST, KNOCKED DOWN」是；
        # 日文「アシスト、名前をダウン」不是）：學習時由「擊倒關鍵字命中的助攻擊倒橫幅」的數量決定
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
        """還原快取中的樣板；格式不符（形狀、資料長度、base64）丟出 ValueError（呼叫端改為重新學習）。"""
        def dec(e):
            if not e:
                return None
            if not isinstance(e, dict):
                raise ValueError("關鍵字樣板格式錯誤")
            shape = e.get("shape")
            if (not isinstance(shape, list) or len(shape) != 2
                    or any(isinstance(x, bool) or not isinstance(x, int) or x <= 0 for x in shape)):
                raise ValueError(f"關鍵字樣板形狀錯誤：{shape!r}")
            h, w = shape
            raw = np.frombuffer(base64.b64decode(e.get("q8") or "", validate=True), dtype=np.uint8)
            if raw.size < h * w:
                raise ValueError("關鍵字樣板資料長度不足")
            return (raw[: h * w].reshape(h, w).astype(np.float32)) / 255.0
        if d is not None and not isinstance(d, dict):
            raise ValueError("關鍵字樣板格式錯誤")
        d = d or {}
        return cls(dec(d.get("assist")), dec(d.get("knock")), bool(d.get("assist_by_knock", False)))

    def scores(self, banner_bgr: np.ndarray, f, profile: Profile) -> tuple[float, float]:
        """(助攻前綴分數, 擊倒關鍵字分數)；沒有該樣板時為 -1。"""
        return self.scores_ink(keyword_ink(banner_bgr, f, profile), f)

    def scores_ink(self, m: np.ndarray, f) -> tuple[float, float]:
        """同 scores，但輸入已是 keyword_ink 算好的第一行筆畫圖（延後驗證時只保存這一小塊）。"""
        a = _match_max(m[:, :f.plus_x], self.assist) if self.assist is not None else -1.0
        k = _match_max(m[:, max(0, f.line_l - 4):f.plus_x], self.knock) if self.knock is not None else -1.0
        return a, k


def keyword_ink(banner_bgr: np.ndarray, f, profile: Profile) -> np.ndarray:
    """關鍵字比對只看第一行「+」號左側：Keywords.scores_ink 需要的筆畫圖範圍。"""
    return row_ink(banner_bgr, f, profile, pad=5)[:, :max(0, f.plus_x)]


def row_ink(banner_bgr: np.ndarray, f, profile: Profile, pad: int = 2) -> np.ndarray:
    """第一行（箭頭同列）的文字筆畫圖（見 ink_mask）。"""
    y0 = max(0, f.chev_y - pad)
    y1 = min(banner_bgr.shape[0], f.chev_y + f.row_h + pad)
    return ink_mask(banner_bgr[y0:y1], profile)


def hand_strip(banner_bgr: np.ndarray, f, hand_hw: tuple[int, int], profile: Profile) -> np.ndarray | None:
    """助攻消滅橫幅：握手圖示右側 PREFIX_W 像素的文字筆畫圖（助攻前綴的錨點）。"""
    th, tw = hand_hw
    x0 = f.hand_x + tw + 4
    b = banner_bgr[max(0, f.hand_y - 2):f.hand_y + th + 2, x0:x0 + PREFIX_W]
    if b.shape[1] != PREFIX_W or b.shape[0] < th + 2:
        return None
    return ink_mask(b, profile).astype(np.float32)


def knock_strip(banner_bgr: np.ndarray, f, profile: Profile) -> np.ndarray | None:
    """擊倒橫幅：敵人色名字左側 KEYWORD_W 像素的文字筆畫圖（擊倒關鍵字的錨點）。"""
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


# 沒有擊殺意義的橫幅類型當前事件的橫幅類型（獨立消滅、小隊抹殺、REVIVE／CRATE REVEAL 等三人加分）
_OTHER_KINDS = frozenset({"elim", "squad_wipe", "score_other"})
PRODUCT_KINDS = frozenset({"knock", "assist_knock", "assist_elim"})


@dataclass(frozen=True)
class Pending:
    """待關鍵字驗證的單人加分格（Detector.prepare 產出、Detector.resolve 定案）：只保留驗證需要的小塊資料，
    不保留整張橫幅，讓「邊解碼邊學關鍵字」時可以先緩衝、學完再定案。"""
    kind: str                 # 圖示線索的類型：knock／assist_knock
    f: IconFrame
    ink: np.ndarray           # keyword_ink：第一行「+」號左側的筆畫圖
    sig: NameSig | None       # 擊倒的敵人名字指紋（圖示判為擊倒時才讀；驗證後仍是擊倒才用）
    spectating: bool


class Detector:
    """單格偵測器：icon_scale 由 calibrate 每支影片決定一次，之後單尺度比對（速度）。"""

    def __init__(self, profile: Profile, icon_scale: float = 1.0, params: IconParams | None = None,
                 keywords: Keywords | None = None):
        self.profile = profile
        self.icon_scale = icon_scale
        self.set_keywords(keywords)
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

    def _verify(self, ink: np.ndarray, f, kind: str) -> str | None:
        """用這支影片學到的關鍵字樣板驗證單人加分橫幅；沒有樣板時不驗證。

        - 助攻前綴命中（行首是「助攻，」之類）→ 助攻擊倒（沒有敵人色名字時，修正圖示線索判錯的擊倒）。
        - 擊倒關鍵字命中 → 維持圖示線索的類型。
        - 都不命中 → None（非擊殺橫幅）；但只驗證「有對應樣板」的類別：擊倒要有擊倒樣板；助攻擊倒要有助攻前綴樣板，
          或這支影片的助攻橫幅含擊倒關鍵字（assist_by_knock）。沒有對應樣板（影片裡沒有足夠的錨點可學；
          日文式的助攻橫幅不含擊倒關鍵字）時維持原判。"""
        kw = self.keywords
        if kw is None:
            return kind
        a, k = kw.scores_ink(ink, f)
        if a >= KW_THRESHOLD:
            return "assist_knock" if f.name_color - f.name_color_bg < self.icons.p.name_color_min else kind
        if k >= KW_THRESHOLD:
            return kind
        # 只有「有對應樣板可驗證」的類別才會被擋：擊倒要有擊倒關鍵字樣板；助攻擊倒要有助攻前綴樣板
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
        """不需要關鍵字樣板的部分：回傳 (FrameResult 或待驗證的 Pending, 圖示特徵)。"""
        spectating = self._spectating(spec_bgr)
        f = self.icons.features(banner_bgr)
        p = self.icons.p
        kind = f.kind
        if kind in ("knock", "assist_knock"):
            sig = self._knock_sig(banner_bgr, f) if kind == "knock" else None
            ink = keyword_ink(banner_bgr, f, self.profile)  # 一律保存：關鍵字可能之後才給（set_keywords）
            return Pending(kind, f, ink, sig, spectating), f
        if kind == "assist_elim":
            return FrameResult(kind, f.hand, f.hand_x, False, None, spectating), f
        if kind in _OTHER_KINDS:
            # 別種橫幅（獨立消滅、小隊抹殺、REVIVE 等）：視同沒有橫幅。橫幅至少停留約 2 秒（8 格），
            # 單格的圖示判斷不確定只是雜訊；連續 ≥ 2 格的非擊殺格依 GAP 規則自然結束進行中的事件。
            return FrameResult(None, 0.0, 0, False, None, spectating), f
        if f.chev >= p.chev_min and f.plus >= p.plus_min:
            # 有加分箭頭與「+」，但人形不確定（淡入淡出）：不算命中，但不中斷進行中的事件
            return FrameResult(None, 0.0, 0, False, None, spectating, hint="cont"), f
        return FrameResult(None, 0.0, 0, False, None, spectating), f

    def resolve(self, r: FrameResult | Pending) -> FrameResult:
        """用目前的關鍵字樣板（set_keywords）定案 prepare 的結果。"""
        if isinstance(r, FrameResult):
            return r
        f = r.f
        kind = self._verify(r.ink, f, r.kind)
        if kind is None:
            # 單人加分圖示但文字不是擊倒／助攻（弱者獎勵、旗幟取回、敵方小隊已消滅…）：視同沒有橫幅
            return FrameResult(None, 0.0, 0, False, None, r.spectating)
        sig = r.sig if kind == "knock" else None
        dmg = f.line2_ink - f.line2_ink_bg >= self.icons.p.line2_ink_min
        return FrameResult(kind, f.chev, f.chev_x, dmg, sig, r.spectating)
