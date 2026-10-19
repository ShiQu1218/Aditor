"""以現行文字偵測器（Detector.detect）對 dump 的每一格做逐格偵測，存 kind/score。用法：text_frames.py LAB:LANG ..."""
import sys, time, json
from fr import *
from aditor.detect import Detector
from aditor.profile import load_profile

TPL = Path(ENGINE).parent / "templates"
for arg in sys.argv[1:]:
    lab, lang = arg.split(":")
    F = load(lab)
    det = Detector(load_profile(TPL / lang), 1.0)
    spec = np.zeros((40, 480, 3), np.uint8)
    kinds, scores = [], []
    t0 = time.time()
    for i in range(len(F)):
        r = det.detect(np.ascontiguousarray(F[i]), spec)
        kinds.append(r.kind or ""); scores.append(r.score)
    dt = time.time() - t0
    np.savez(SP / "out" / f"text_{lab}_{lang}.npz", kind=np.array(kinds), score=np.array(scores, np.float32))
    print(lab, lang, len(F), f"{dt:.1f}s", f"{1000*dt/len(F):.2f} ms/frame",
          {k: kinds.count(k) for k in set(kinds)}, flush=True)
