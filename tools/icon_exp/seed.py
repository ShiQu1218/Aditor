"""從訓練素材（EN/JA）手動選定的畫格裁出種子圖示（灰階），並量測各片的最佳尺度分布。"""
from fr import *
import collections

SEEDS = {  # name: (lab, t, x0, y0, x1, y1)  — 皆為訓練素材
    "chev":   ("EN", 25.0, 571, 75, 603, 107),
    "person": ("EN", 25.0, 603, 73, 623, 108),
    "group":  ("EN", 172.25, 512, 74, 548, 108),
    "skull":  ("EN", 37.25, 247, 78, 271, 104),
    "hand":   ("JA", 1023.0, 189, 67, 220, 91),
}
out = SP / "seed"; out.mkdir(exist_ok=True)
T = {}
for k, (lab, t, x0, y0, x1, y1) in SEEDS.items():
    g = cv2.cvtColor(np.ascontiguousarray(load(lab)[idx(t)][y0:y1, x0:x1]), cv2.COLOR_BGR2GRAY)
    cv2.imwrite(str(out / f"{k}.png"), g); T[k] = g
print(cv2.__version__)
# 尺度分布：種子 chev 在 EN/JA/SC1 每 2 格取 1 格
scales = [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2]
for lab in ["EN", "JA", "SC1"]:
    F = load(lab); hist = collections.Counter(); ys = collections.Counter()
    for i in range(0, len(F), 2):
        g = cv2.cvtColor(np.ascontiguousarray(F[i][30:150]), cv2.COLOR_BGR2GRAY)
        best = (0, 0, 0)
        for s in scales:
            t = cv2.resize(T["chev"], None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
            r = cv2.matchTemplate(g, t, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(r)
            if mx > best[0]:
                best = (mx, s, loc[1] + 30)
        if best[0] > 0.8:
            hist[best[1]] += 1; ys[best[2] // 4 * 4] += 1
    print(lab, sorted(hist.items()), sorted(ys.items()))
