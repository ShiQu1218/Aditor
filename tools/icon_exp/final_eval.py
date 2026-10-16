"""最終評估（凍結參數 v1；diag 特徵＝多尺度 0.9–1.1）。輸出 markdown 表到 stdout。"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ana import *

AUGD = json.loads((TOOLS / "truth_aug.json").read_text(encoding="utf-8"))
SUB = {"TC": {334.75: "assist_knock", 339.75: "assist_elim", 855.25: "assist_knock", 877.0: "assist_knock"},
       "ENG": {467.0: "assist_knock", 1556.5: "assist_knock"}}
MAP = {"knock": "K", "assist_knock": "A", "assist_elim": "A"}
PM = {"knock": "K", "assist": "A"}
tag = sys.argv[1] if len(sys.argv) > 1 else "diag"


def truth_full(lab):
    """[(t, product K/A, fine type)]，含目視修正。"""
    a = AUGD[lab]
    mv = {o: n for o, n in a["move"]}
    rt = {t: c for t, c in a["retype"]}
    ev = []
    for t, ty in gt(lab):
        if ty in MAP:
            fine = SUB.get(lab, {}).get(t, ty)
            c = rt.get(t, MAP[ty])
            ev.append((mv.get(t, t), c, fine))
    for t, c in a["add"]:
        ev.append((t, c, SUB.get(lab, {}).get(t, "knock" if c == "K" else "assist_knock")))
    return sorted(ev)


rows = []
for lab in ["TC", "ENG", "JP"]:
    ev = truth_full(lab)
    runs = icon_runs(lab, IconParams(), tag)
    IR = [(r["t"], r["end"], PM[r["product"]], r["n"], r["type"]) for r in runs if r["product"]]
    pairs, um, mi = match([x[:4] for x in IR], [(t, c) for t, c, _ in ev])
    anyR = [(r[0], r[1], "X", r[3]) for r in IR]
    p2, um2, _ = match(anyR, [(t, "X") for t, _, _ in ev])
    # 助攻子類型（附帶）：已配對的 A 事件，圖示內部類型 vs 真值細類
    sub_ok = sum(1 for ei, ri in pairs if ev[ei][1] == "A" and IR[ri][4] == ev[ei][2])
    sub_n = sum(1 for ei, ri in pairs if ev[ei][1] == "A")
    # 獨立擊殺／小隊抹殺被誤判成 K/A：真值 elim/squad_wipe 起點 ±1.5 s 內有「沒對上 K/A 真值」的圖示 run
    used_any = {ri for _, ri in p2}
    neg = [(t, ty) for t, ty in gt(lab) if ty in ("elim", "squad_wipe")]
    mis = [(t, ty) for t, ty in neg if any(abs(IR[ri][0] - t) <= 1.5 for ri in range(len(IR)) if ri not in used_any)]
    k_n = sum(1 for e in ev if e[1] == "K"); a_n = len(ev) - k_n
    k_m = sum(1 for ei, _ in pairs if ev[ei][1] == "K"); a_m = len(pairs) - k_m
    rows.append(dict(lab=lab, truth=len(ev), K=f"{k_m}/{k_n}", A=f"{a_m}/{a_n}", recall=len(pairs) / len(ev),
                     anytype=len(p2) / len(ev), runs=len(IR), prec_any=len(p2) / max(1, len(IR)),
                     prec_typed=len(pairs) / max(1, len(IR)), sub=f"{sub_ok}/{sub_n}",
                     neg=len(neg), neg_mis=len(mis), mis=mis, um_any=[(r[0], r[2], r[3]) for r in um2]))
print("| 片 | 真值 K+A | K 召回 | A 召回 | 類型正確召回 | 不分類型召回 | 圖示 run | 精確度（不分類型） | 精確度（類型正確） | 助攻子類型正確 | elim/squad_wipe 被誤判 |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    print(f"| {r['lab']} | {r['truth']} | {r['K']} | {r['A']} | {r['recall']:.3f} | {r['anytype']:.3f} | {r['runs']} | {r['prec_any']:.3f} | {r['prec_typed']:.3f} | {r['sub']} | {r['neg_mis']}/{r['neg']} |")
for r in rows:
    print(r["lab"], "unmatched(any-type) runs:", r["um_any"], "neg misfires:", r["mis"])
