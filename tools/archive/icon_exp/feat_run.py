"""Run IconDetector on each dumped frame (diag mode, low gate threshold) and save features. Usage: feat_run.py LAB [tag] [scales]"""
import sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fr import *
from aditor.icon_detect import IconDetector, IconParams, IconFrame
from dataclasses import fields

lab = sys.argv[1]; tag = sys.argv[2] if len(sys.argv) > 2 else "diag"
scales = tuple(float(s) for s in sys.argv[3].split(",")) if len(sys.argv) > 3 else (0.9, 0.95, 1.0, 1.05, 1.1)
F = load(lab)
gate = IconParams(chev_min=0.4, left_min=0.4) if tag == "diag" else IconParams()
det = IconDetector(Path(ENGINE).parent / "templates" / "icons", scales, gate, diag=(tag == "diag"))
names = [f.name for f in fields(IconFrame) if f.name != "kind"]
rows = []
t0 = time.time()
for i in range(len(F)):
    f = det.features(np.ascontiguousarray(F[i]))
    rows.append([getattr(f, n) for n in names])
dt = time.time() - t0
np.savez(SP / "out" / f"icon_{lab}_{tag}.npz", names=np.array(names), X=np.array(rows, np.float32))
print(lab, tag, len(F), f"{dt:.1f}s {1000*dt/len(F):.2f} ms/frame", flush=True)
