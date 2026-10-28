"""SC2 (acceptance, Simplified Chinese, red names, no text ground truth): list all icon runs and export contact sheets; also sample 20 non-hit intervals."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ana import *
lab = sys.argv[1] if len(sys.argv) > 1 else "SC2"
R = icon_runs(lab); F = load(lab)
for i, r in enumerate(R):
    print(i, r["t"], r["end"], r["family"], r["type"], r["product"], r["n"])
for b in range(0, len(R), 16):
    ch = R[b:b + 16]
    sheet([F[idx((r["t"] + r["end"]) / 2)] for r in ch], [f"#{b+i} {r['t']} {r['type']}" for i, r in enumerate(ch)],
          SP / f"{lab.lower()}_{b//16}.png", cols=2, scale=0.75, rows=(40, 140))
# Non-hit intervals: divide times outside all runs (±3 s) into 3-second segments, sample 20 with a fixed random seed, and take 3 frames at 1 fps from each.
rng = np.random.default_rng(0)
covered = np.zeros(len(F), bool)
for r in R:
    covered[max(0, idx(r["t"] - 3)):idx(r["end"] + 3) + 1] = True
segs = [s for s in range(0, len(F) - 12, 12) if not covered[s:s + 12].any()]
pick = sorted(rng.choice(segs, size=min(20, len(segs)), replace=False))
imgs, lbl = [], []
for s in pick:
    for k in (0, 4, 8):
        imgs.append(F[s + k]); lbl.append(f"{(s+k)/4}")
for b in range(0, len(imgs), 24):
    sheet(imgs[b:b + 24], lbl[b:b + 24], SP / f"{lab.lower()}_neg_{b//24}.png", cols=3, scale=0.5, rows=(40, 140))
print("neg segments", [s / 4 for s in pick])
