"""共用分析：載入特徵、離線分類、聚 run、與基準事件比對。"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fr import *
from aditor.icon_detect import IconDetector, IconParams, IconFrame

# 現行引擎在驗收片的事件 JSON（<LAB>_j1.json）：環境變數 ICON_EXP_BASELINE
FIX = Path(os.environ.get("ICON_EXP_BASELINE", "after3"))
TPL = Path(ENGINE).parent / "templates" / "icons"
GROUP = {"knock": "K", "assist_knock": "A", "assist_elim": "A"}  # 產品範圍：擊倒 K、助攻 A


def feats(lab, tag="diag"):
    d = np.load(SP / "out" / f"icon_{lab}_{tag}.npz")
    return [str(n) for n in d["names"]], d["X"]


def frames(lab, params=None, tag="diag"):
    names, X = feats(lab, tag)
    det = IconDetector.__new__(IconDetector)
    det.p = params or IconParams()
    ints = {"chev_x", "chev_y", "skull_x", "skull_y", "hand_x", "hand_y", "line2_icons", "name_color"}
    out = []
    for row in X:
        f = IconFrame(**{n: (int(v) if n in ints else float(v)) for n, v in zip(names, row)})
        f.kind = det.classify(f)
        out.append(f)
    return out


def icon_runs(lab, params=None, tag="diag"):
    from runs_proto import build_runs
    fr_ = frames(lab, params, tag)
    return build_runs([i / 4 for i in range(len(fr_))], fr_, params or IconParams())


def classify(lab, params=None, tag="diag"):
    names, X = feats(lab, tag)
    det = IconDetector.__new__(IconDetector)
    det.p = params or IconParams()
    ints = {"chev_x", "chev_y", "skull_x", "skull_y", "hand_x", "hand_y", "line2_icons", "name_color"}
    out = []
    for row in X:
        f = IconFrame(**{n: (int(v) if n in ints else float(v)) for n, v in zip(names, row)})
        out.append(det.classify(f) or "")
    return np.array(out)


def text(lab, lang):
    return np.load(SP / "out" / f"text_{lab}_{lang}.npz")["kind"]


def runs_of(cls, min_len=2, gap=1):
    """cls：逐格類別（K/A/...，空字串＝無）。同類連續格（容許 gap 格中斷）聚成 run。
    回傳 [(start_t, end_t, cls, n)]。"""
    out = []
    n = len(cls)
    i = 0
    while i < n:
        c = cls[i]
        if not c:
            i += 1; continue
        j = i; last = i; cnt = 1
        while j + 1 < n:
            j += 1
            if cls[j] == c:
                cnt += 1; last = j
            elif j - last > gap:
                break
        if cnt >= min_len:
            out.append((i / 4, last / 4, c, cnt))
        i = last + 1
    return out


def runs_any(cls, min_len=2, gap=1):
    """任何非空類別的連續格（容許 gap 格中斷）聚成一個 run，類型取多數。"""
    b = np.array([bool(c) for c in cls])
    out = []
    for s, e, _, n in runs_of(np.where(b, "X", ""), min_len, gap):
        seg = [c for c in cls[idx(s):idx(e) + 1] if c]
        vals, cnt = np.unique(seg, return_counts=True)
        out.append((s, e, str(vals[np.argmax(cnt)]), n))
    return out


def gt(lab):
    d = json.loads((FIX / f"{lab}_j1.json").read_text(encoding="utf-8"))
    return [(e["t"], e["type"]) for e in d["events"]]


def match(runs, events, tol=1.5):
    """一對一貪婪比對（同組類別、起點差 ≤ tol）。回傳 (matched pairs, unmatched runs, missed events)。"""
    pairs, used = [], set()
    for ei, (t, ty) in enumerate(events):
        best = None
        for ri, r in enumerate(runs):
            if ri in used or r[2] != ty:
                continue
            d = abs(r[0] - t)
            if d <= tol and (best is None or d < best[0]):
                best = (d, ri)
        if best:
            used.add(best[1]); pairs.append((ei, best[1]))
    um = [r for ri, r in enumerate(runs) if ri not in used]
    mi = [events[ei] for ei in range(len(events)) if ei not in {p[0] for p in pairs}]
    return pairs, um, mi
