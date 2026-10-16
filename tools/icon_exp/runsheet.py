"""runsheet.py LAB out_prefix [--p=...] [--all]：列出圖示 run，並把每個 run 的中間格拼成接觸表（每張 12 個）。
--all：含負類別（elim/squad_wipe/score_other）的 run。"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ana import *
kv = {}
for a in sys.argv[1:]:
    if a.startswith("--p="):
        kv = {k: float(v) for k, v in (x.split("=") for x in a[4:].split(","))}
args = [a for a in sys.argv[1:] if not a.startswith("--")]
lab, pre = args[0], args[1]
cls = classify(lab, IconParams(**kv))
if "--all" not in sys.argv:
    cls = np.array([{"knock": "K", "assist_knock": "A", "assist_elim": "A"}.get(c, "") for c in cls])
R = runs_any(cls)
F = load(lab)
print(lab, len(R), "runs")
for r in R:
    print(f"  {r[0]:8.2f}-{r[1]:8.2f} {r[2]} n={r[3]}")
for b in range(0, len(R), 12):
    chunk = R[b:b + 12]
    imgs = [F[idx((r[0] + r[1]) / 2)] for r in chunk]
    sheet(imgs, [f"#{b+i} {r[0]} {r[2]}" for i, r in enumerate(chunk)], SP / f"{pre}_{b//12}.png", cols=2, scale=0.75, rows=(40, 140))
