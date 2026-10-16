"""vis_um.py LAB：把未對上真值的圖示 run（中間格）與漏掉的真值事件（t+0.5）拼成接觸表。"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ana import *
lab = sys.argv[1]
MAP = {"knock": "K", "assist_knock": "A", "assist_elim": "A"}
PM = {"knock": "K", "assist": "A"}
ev = [(t, MAP[ty]) for t, ty in gt(lab) if ty in MAP]
runs = icon_runs(lab)
IR = [(r["t"], r["end"], PM[r["product"]], r["n"]) for r in runs if r["product"]]
pairs, um, mi = match(IR, ev)
F = load(lab)
items = [(F[idx((r[0] + r[1]) / 2)], f"UM {r[0]} {r[2]} n{r[3]}") for r in um] + \
        [(F[idx(t + 0.5)], f"MISS {t} {c}") for t, c in mi]
for b in range(0, len(items), 16):
    ch = items[b:b + 16]
    sheet([c[0] for c in ch], [c[1] for c in ch], SP / f"um_{lab}_{b//16}.png", cols=2, scale=0.75, rows=(40, 140))
print(len(um), len(mi))
