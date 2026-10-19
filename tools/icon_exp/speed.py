"""速度：ENG 前 2000 格（單執行緒、不含解碼）。"""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ana import *
from aditor.detect import Detector
from aditor.profile import load_profile
cv2.setNumThreads(1)
F = load("ENG"); N = 2000
frames_ = [np.ascontiguousarray(F[i]) for i in range(N)]
spec = np.zeros((40, 480, 3), np.uint8)
d = Detector(load_profile(Path(ENGINE).parent / "templates" / "en"), 1.0)
t0 = time.perf_counter()
for f in frames_:
    d.detect(f, spec)
print(f"text Detector(en): {1000*(time.perf_counter()-t0)/N:.2f} ms/frame")
for sc in [(0.9, 0.95, 1.0, 1.05, 1.1), (0.95, 1.0, 1.05), (1.0,)]:
    det = IconDetector(TPL, sc)
    t0 = time.perf_counter()
    ks = [det.features(f).kind for f in frames_]
    print(f"icon scales={sc}: {1000*(time.perf_counter()-t0)/N:.2f} ms/frame, hits={sum(1 for k in ks if k)}")
