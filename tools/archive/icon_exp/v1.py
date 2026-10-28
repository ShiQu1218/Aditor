import sys
from fr import *
lab = sys.argv[1]; out = sys.argv[2]; ts = [float(x) for x in sys.argv[3:]]
F = load(lab)
sheet([F[idx(t)] for t in ts], [f"{lab} {t}" for t in ts], SP / out, cols=1)
