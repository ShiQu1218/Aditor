"""圖示偵測原型的離線 run 聚合（已被 apexhl.events.EventTracker 取代，僅供 tools/icon_exp 重現實驗報告）。"""
from __future__ import annotations

import numpy as np

from apexhl.icon_detect import IconFrame, IconParams, is_knock

# ---- 事件層（原型）：逐格結果 → run → 產品類別 ----
# 逐格「圖示家族」：P＝加分箭頭＋單人（擊倒／助攻擊倒）、G＝加分箭頭＋三人（小隊抹殺、REVIVE…）、
# U＝有加分箭頭但人形不確定（淡入淡出）、SK＝第一行骷髏（獨立擊殺）、HD＝第一行握手（助攻消滅）。
FAMILY = {"knock": "P", "assist_knock": "P", "squad_wipe": "G", "score_other": "G",
          "elim": "SK", "assist_elim": "HD"}


SPLIT_PERSIST = 3  # 單人加分 run 內擊倒／助攻擊倒類別要持續幾格才切成兩個事件


# v2（看過驗收片的漏報後才加的規則，報告中與 v1 分開列）：橫幅整塊置中，換成另一個橫幅時
# 名字長度不同 → 箭頭 x 位置跳動。箭頭 x 與前 3 格中位數差 > SPLIT_X 且下一格也一樣 → 切成新事件。0＝關閉（v1）。
SPLIT_X = 0


def _split_by_x(ks: list[int], frames: list[IconFrame]) -> list[list[int]]:
    if SPLIT_X <= 0 or len(ks) < 4:
        return [ks]
    xs = [frames[k].chev_x for k in ks]
    groups, cur = [], [0]
    for j in range(1, len(ks)):
        ref = float(np.median([xs[q] for q in cur[-3:]]))
        nxt_ok = j + 1 < len(ks) and abs(xs[j + 1] - ref) > SPLIT_X
        if abs(xs[j] - ref) > SPLIT_X and nxt_ok and len(cur) >= 2:
            groups.append(cur)
            cur = [j]
        else:
            cur.append(j)
    groups.append(cur)
    return [[ks[j] for j in g] for g in groups]


def frame_family(f: IconFrame, p: IconParams) -> str:
    if f.kind is None:
        if f.chev >= p.chev_min and f.plus >= p.plus_min:
            return "U"
        return ""
    return FAMILY.get(f.kind, "")


def build_runs(times: list[float], frames: list[IconFrame], p: IconParams | None = None,
               min_len: int = 2, gap: int = 1) -> list[dict]:
    """把逐格結果聚成 run（同家族連續格，容許 gap 格中斷；U 可接在 P／G run 中），
    再以 run 內的中位數特徵決定產品類別：
      P  → knock（敵人色名字或第二行）／assist_knock（白字單行）
      HD → assist_elim
      G、SK → 非產品事件（小隊抹殺／加分提示／獨立擊殺）：輸出 product=None 供誤報分析
    回傳 [{"t", "end", "family", "type", "product", "n", "chev"}]；t＝第一格時間（與現行追蹤器相同基準）。"""
    p = p or IconParams()
    fam = [frame_family(f, p) for f in frames]
    out = []
    i, n = 0, len(fam)
    while i < n:
        c = fam[i]
        if not c or c == "U":
            i += 1
            continue
        last, cnt, j = i, 1, i
        while j + 1 < n:
            j += 1
            fj = fam[j]
            if fj == c or (fj == "U" and c in ("P", "G")):
                cnt += 1
                last = j
            elif j - last > gap:
                break
            elif fj and fj != "U":
                break  # 換成別的家族：結束（下一個 run 從這格開始）
        if cnt >= min_len and c == "P":
            # 單人加分 run：逐格判擊倒／助攻擊倒；同一個 run 內若類別持續改變（兩側各 ≥ SPLIT_PERSIST 格）
            # 視為兩個接連的橫幅（例：擊倒後緊接助攻擊倒，中間沒有空白格），切開
            ks_all = [k for k in range(i, last + 1) if fam[k] == "P"]
            for gi, ks in enumerate(_split_by_x(ks_all, frames)):
                lab = [is_knock(frames[k], p) for k in ks]
                segs, a = [], 0  # 同值連續段 [起, 迄)
                for b in range(1, len(lab) + 1):
                    if b == len(lab) or lab[b] != lab[a]:
                        segs.append([a, b])
                        a = b
                keep = [s for s in segs if s[1] - s[0] >= SPLIT_PERSIST]  # 短段（閃爍）併入前後
                cuts = [0] + [s[0] for s in keep[1:] if lab[s[0]] != lab[keep[keep.index(s) - 1][0]]] + [len(lab)]
                for s0, s1 in zip(cuts, cuts[1:]):
                    sub = lab[s0:s1]
                    typ = "knock" if sum(sub) * 2 > len(sub) else "assist_knock"
                    k0, k1 = ks[s0], ks[s1 - 1]
                    if s0 == 0 and gi == 0:
                        k0 = i
                    out.append({"t": times[k0], "end": times[k1], "family": "P", "type": typ,
                                "product": "knock" if typ == "knock" else "assist",
                                "n": s1 - s0, "chev": float(np.median([frames[k].chev for k in ks[s0:s1]]))})
            i = last + 1
        elif cnt >= min_len:
            seg = [frames[k] for k in range(i, last + 1) if fam[k] in (c, "U")]
            typ = c
            if c == "G":
                typ = "squad_wipe" if np.median([f.line2_icons for f in seg]) >= 1 else "score_other"
            elif c == "SK":
                typ = "elim"
            elif c == "HD":
                typ = "assist_elim"
            product = {"knock": "knock", "assist_knock": "assist", "assist_elim": "assist"}.get(typ)
            out.append({"t": times[i], "end": times[last], "family": c, "type": typ, "product": product,
                        "n": cnt, "chev": float(np.median([f.chev for f in seg]))})
            i = last + 1
        else:
            i += 1
    return out
