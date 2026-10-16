"""列出文字偵測逐格結果聚成的 run：tlist.py LAB LANG"""
import sys
from fr import *
lab, lang = sys.argv[1], sys.argv[2]
d = np.load(SP / "out" / f"text_{lab}_{lang}.npz")
k = d["kind"]
runs = []
i = 0
while i < len(k):
    if k[i]:
        j = i
        while j + 1 < len(k) and k[j + 1]:
            j += 1
        vals, cnt = np.unique(k[i:j + 1], return_counts=True)
        runs.append((i / 4, (j - i + 1), dict(zip(vals.tolist(), cnt.tolist()))))
        i = j + 1
    else:
        i += 1
for r in runs:
    print(r)
