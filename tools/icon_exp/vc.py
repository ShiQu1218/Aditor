"""vc.py LAB out.png t1 t2 ... [--p=...]：顯示畫格與逐格圖示分類、主要特徵。"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ana import *
kv = {}
for a in sys.argv[1:]:
    if a.startswith("--p="):
        kv = {k: float(v) for k, v in (x.split("=") for x in a[4:].split(","))}
args = [a for a in sys.argv[1:] if not a.startswith("--")]
lab, out, ts = args[0], args[1], [float(x) for x in args[2:]]
F = load(lab)
cls = classify(lab, IconParams(**kv))
names, X = feats(lab)
ix = {n: i for i, n in enumerate(names)}
lbl = []
for t in ts:
    r = X[idx(t)]
    lbl.append(f"{lab} {t} [{cls[idx(t)]}] ch{r[ix['chev']]:.2f} p{r[ix['person']]:.2f} g{r[ix['group']]:.2f} sk{r[ix['skull']]:.2f} hd{r[ix['hand']]:.2f} l2i{int(r[ix['line2_icons']])} l2k{r[ix['line2_ink']]:.3f} nc{int(r[ix['name_color']])}")
sheet([F[idx(t)] for t in ts], lbl, SP / out, cols=1)
