"""事件級評估（產品範圍：K＝knock、A＝assist_knock＋assist_elim）。
用法：ev.py LAB... [--p=key=val,...] [--list]
近似真值：訓練片（EN/JA）＝文字偵測器逐格結果聚成的 run；驗收片（TC/ENG/JP）＝after3 引擎事件。
另算：文字法逐格 run（無追蹤器）、圖示 OR 文字、圖示 AND 文字。"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ana import *

LANG = {"EN": "en", "JA": "ja", "TC": "zh-TW", "ENG": "en", "JP": "ja"}
args = [a for a in sys.argv[1:] if not a.startswith("--")]
kv = {}
for a in sys.argv[1:]:
    if a.startswith("--p="):
        kv = {k: float(v) for k, v in (x.split("=") for x in a[4:].split(","))}
import apexhl.icon_detect as _idm
if "splitx" in kv:
    _idm.SPLIT_X = int(kv.pop("splitx"))
if "split" in kv:
    _idm.SPLIT_PERSIST = int(kv.pop("split"))
P = IconParams(**kv)
LIST = "--list" in sys.argv
AUG = "--aug" in sys.argv
TAG = next((a[6:] for a in sys.argv if a.startswith("--tag=")), "diag")
AUGD = json.loads((TOOLS / "truth_aug.json").read_text(encoding="utf-8"))
MAP = {"knock": "K", "assist_knock": "A", "assist_elim": "A"}
PM = {"knock": "K", "assist": "A"}


def text_runs(lab):
    return runs_any(np.array([MAP.get(k, "") for k in text(lab, LANG[lab])]))


# SC1（訓練、簡中、黃名）：沒有文字偵測器，以接觸表目視標註（scratchpad rs_sc1_*.png）
SC1_TRUTH = [(312.25, "K"), (315.0, "K"), (334.0, "K"), (354.5, "K"), (577.75, "K"), (672.75, "K"), (685.25, "K"),
             (296.75, "A"), (357.25, "A"), (364.25, "A")]


def truth(lab):
    if lab == "SC1":
        return sorted(SC1_TRUTH)
    if lab in ("EN", "JA"):
        return [(r[0], r[2]) for r in text_runs(lab)]
    ev = [(t, MAP[ty]) for t, ty in gt(lab) if ty in MAP]
    if AUG and lab in AUGD:
        a = AUGD[lab]
        mv = {o: n for o, n in a["move"]}
        rt = {t: c for t, c in a["retype"]}
        ev = [(mv.get(t, t), rt.get(t, c)) for t, c in ev] + [tuple(x) for x in a["add"]]
    return sorted(ev)


def overlap(a, b, pad=0.5):
    return a[0] - pad <= b[1] and b[0] - pad <= a[1]


def score(R, ev):
    pairs, um, mi = match(R, ev)
    anyR = [(r[0], r[1], "X", r[3]) for r in R]
    p2, _, _ = match(anyR, [(t, "X") for t, _ in ev])
    d = {"n_truth": len(ev), "runs": len(R), "match": len(pairs), "match_anytype": len(p2), "unmatched": len(um)}
    for c in "KA":
        d[c] = (sum(1 for ei, _ in pairs if ev[ei][1] == c), sum(1 for e in ev if e[1] == c))
    return d, um, mi


res = {}
for lab in args:
    ev = truth(lab)
    IR = [(r["t"], r["end"], PM[r["product"]], r["n"]) for r in icon_runs(lab, P, TAG) if r["product"]]
    TR = text_runs(lab) if lab in LANG else []
    OR = list(IR) + [t for t in TR if not any(overlap(t, i) for i in IR)]
    OR.sort()
    AND = [i for i in IR if any(overlap(i, t) for t in TR)]
    out = {}
    ENGR = [(t, t + 2.0, MAP[ty], 9) for t, ty in gt(lab) if ty in MAP] if lab in ("TC", "ENG", "JP") else []
    OR2 = list(IR) + [t for t in ENGR if not any(overlap(t, i) for i in IR)]
    for name, R in [("icon", IR), ("text_frames", TR), ("engine_after3", ENGR), ("icon_OR_text", OR), ("icon_OR_engine", sorted(OR2)), ("icon_AND_text", AND)]:
        d, um, mi = score(R, ev)
        out[name] = d
        print(f"{lab:4s} {name:14s} truth={d['n_truth']:3d} runs={d['runs']:3d} recall={d['match']/max(1,d['n_truth']):.3f} "
              f"anytype={d['match_anytype']/max(1,d['n_truth']):.3f} unmatched_runs={d['unmatched']:3d} K {d['K'][0]}/{d['K'][1]} A {d['A'][0]}/{d['A'][1]}")
        if LIST and name == "icon":
            print("   missed:", [(t, c) for t, c in mi])
            print("   unmatched:", [(r[0], r[2], r[3]) for r in um])
    res[lab] = out
(SP / "out" / "ev_last.json").write_text(json.dumps(res, indent=1))
