"""Align and average seed icons from training data (EN, JA, SC1) into refined templates in two passes. Reads training data only.
Writes templates/icons/<name>.png and statistics (chev was later restored to its seed, and person was cropped to 17 columns; see the report)."""
from fr import *

DST = Path(ENGINE).parent / "templates" / "icons"; DST.mkdir(parents=True, exist_ok=True)
SCALES = [0.9, 0.95, 1.0, 1.05, 1.1]
TRAIN = ["EN", "JA", "SC1"]


def rs(t, s):
    return t if s == 1.0 else cv2.resize(t, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)


def best(g, t):
    out = (-1, 0, 0, 1.0)
    for s in SCALES:
        tt = rs(t, s)
        if g.shape[0] < tt.shape[0] or g.shape[1] < tt.shape[1]:
            continue
        r = cv2.matchTemplate(g, tt, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(r)
        if mx > out[0]:
            out = (mx, loc[0], loc[1], s)
    return out


def crop_back(g, x, y, s, shape):
    h, w = shape
    hs, ws = int(round(h * s)), int(round(w * s))
    c = g[y:y + hs, x:x + ws]
    if c.shape != (hs, ws):
        return None
    return cv2.resize(c, (w, h), interpolation=cv2.INTER_LINEAR).astype(np.float32)


T = {k: cv2.imread(str(SP / "seed" / f"{k}.png"), 0) for k in ["chev", "person", "group", "skull", "hand"]}
for rnd in range(1):
    acc = {k: [] for k in T}
    for lab in TRAIN:
        F = load(lab)
        for i in range(len(F)):
            g = cv2.cvtColor(np.ascontiguousarray(F[i][30:150]), cv2.COLOR_BGR2GRAY)
            sc, x, y, s = best(g, T["chev"])
            if sc >= 0.85:
                c = crop_back(g, x, y, s, T["chev"].shape)
                if c is not None:
                    acc["chev"].append(c)
                cw = int(round(T["chev"].shape[1] * s))
                x0, y0 = x + cw - 4, max(0, y - 8)
                sub = g[y0:y0 + int(50 * s), x0:x0 + int(50 * s)]
                fs = {k: best(sub, T[k]) for k in ("person", "group")}
                k = max(fs, key=lambda q: fs[q][0])
                if fs[k][0] >= 0.85 and fs[k][0] - min(v[0] for v in fs.values()) >= 0.15:
                    c = crop_back(sub, fs[k][1], fs[k][2], fs[k][3], T[k].shape)
                    if c is not None:
                        acc[k].append(c)
            for k in ("skull", "hand"):
                sc, x, y, s = best(g, T[k])
                if sc >= 0.85:
                    c = crop_back(g, x, y, s, T[k].shape)
                    if c is not None:
                        acc[k].append(c)
    for k, lst in acc.items():
        if len(lst) >= 5:
            T[k] = np.clip(np.median(lst, axis=0), 0, 255).astype(np.uint8)
        print("round", rnd, k, len(lst), flush=True)
for k, t in T.items():
    cv2.imwrite(str(DST / f"{k}.png"), t)
print({k: t.shape for k, t in T.items()})

