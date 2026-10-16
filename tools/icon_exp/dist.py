"""訓練素材：依文字偵測器的逐格標籤，列出圖示特徵分布（只看 EN/JA）。"""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ana import *
cols = ["chev", "plus", "person", "group", "skull", "hand", "left_above", "line2_icons", "line2_ink", "name_color"]
for lab, lang in [("EN", "en"), ("JA", "ja")]:
    names, X = feats(lab)
    tk = text(lab, lang)
    ix = {n: names.index(n) for n in cols}
    print("==", lab)
    for k in ["knock", "assist_knock", "assist_elim", "elim", "squad_wipe", ""]:
        m = tk == k
        if not m.any():
            continue
        sub = X[m]
        print(f"{k or 'none':13s} n={m.sum():5d}", " ".join(
            f"{c}:{np.percentile(sub[:, ix[c]], 5):.2f}/{np.median(sub[:, ix[c]]):.2f}/{np.percentile(sub[:, ix[c]], 95):.2f}" for c in cols))


