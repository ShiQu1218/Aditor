"""Offline run aggregation prototype for icon detection (superseded by aditor.events.EventTracker; retained only to reproduce the tools/icon_exp experiment report)."""
from __future__ import annotations

import numpy as np

from aditor.icon_detect import IconFrame, IconParams, is_knock

# ---- Event layer (prototype): per-frame results -> runs -> product classes ----
# Per-frame icon families: P = score arrow + one person (knock/assist knock), G = score arrow + three people (squad wipe, REVIVE, ...),
# U = score arrow with uncertain person shape (fade transition), SK = skull on first line (independent kill), HD = handshake on first line (assist elim).
FAMILY = {"knock": "P", "assist_knock": "P", "squad_wipe": "G", "score_other": "G",
          "elim": "SK", "assist_elim": "HD"}


SPLIT_PERSIST = 3  # Consecutive frames a knock/assist-knock class must persist in a single-person score run before splitting it into two events.


# v2 (added after reviewing missed events in acceptance clips; reported separately from v1): the whole banner is centered, so changing to a banner with a different name length shifts the arrow's x position.
# If the arrow x differs from the median of the previous 3 frames by more than SPLIT_X and the next frame agrees, split into a new event. 0 disables this rule (v1).
SPLIT_X = 0


def _split_by_x(ks: list[int], frames: list[IconFrame]) -> list[list[int]]:
    if SPLIT_X <= 0 or len(ks) < 4:
        return [ks]
    xs = [frames[k].chev_x for k in ks]
    groups, cur = [], [0]
    for j in range(1, len(ks)):
        ref = float(np.median([xs[q] for q in cur[-3:]]))
        nxt_ok = j + 1 < len(ks) and abs(xs[j + 1] - ref) > SPLIT_X
        if abs(xs[j] - ref) > SPLIT_X and nxt_ok and len(cur) >= 2:
            groups.append(cur)
            cur = [j]
        else:
            cur.append(j)
    groups.append(cur)
    return [[ks[j] for j in g] for g in groups]


def frame_family(f: IconFrame, p: IconParams) -> str:
    if f.kind is None:
        if f.chev >= p.chev_min and f.plus >= p.plus_min:
            return "U"
        return ""
    return FAMILY.get(f.kind, "")


def build_runs(times: list[float], frames: list[IconFrame], p: IconParams | None = None,
               min_len: int = 2, gap: int = 1) -> list[dict]:
    """Group per-frame results into runs (consecutive frames in the same family, allowing gap frames; U may join a P/G run),
    then determine the product class from median features within each run:
      P -> knock (enemy-colored name or second line) / assist_knock (single white-text line)
      HD -> assist_elim
      G, SK -> non-product events (squad wipe/score notification/independent kill): emit product=None for false-positive analysis
    Return [{"t", "end", "family", "type", "product", "n", "chev"}]; t is the first frame time (same basis as the current tracker)."""
    p = p or IconParams()
    fam = [frame_family(f, p) for f in frames]
    out = []
    i, n = 0, len(fam)
    while i < n:
        c = fam[i]
        if not c or c == "U":
            i += 1
            continue
        last, cnt, j = i, 1, i
        while j + 1 < n:
            j += 1
            fj = fam[j]
            if fj == c or (fj == "U" and c in ("P", "G")):
                cnt += 1
                last = j
            elif j - last > gap:
                break
            elif fj and fj != "U":
                break  # A different family ends this run; the next run starts at this frame.
        if cnt >= min_len and c == "P":
            # For a single-person score run, classify each frame as knock/assist-knock. If the class changes persistently (at least SPLIT_PERSIST frames on both sides),
            # treat it as two consecutive banners (for example, a knock immediately followed by an assist knock with no gap) and split the run.
            ks_all = [k for k in range(i, last + 1) if fam[k] == "P"]
            for gi, ks in enumerate(_split_by_x(ks_all, frames)):
                lab = [is_knock(frames[k], p) for k in ks]
                segs, a = [], 0  # Consecutive same-value spans [start, end).
                for b in range(1, len(lab) + 1):
                    if b == len(lab) or lab[b] != lab[a]:
                        segs.append([a, b])
                        a = b
                keep = [s for s in segs if s[1] - s[0] >= SPLIT_PERSIST]  # Merge short (flickering) spans into adjacent spans.
                cuts = [0] + [s[0] for s in keep[1:] if lab[s[0]] != lab[keep[keep.index(s) - 1][0]]] + [len(lab)]
                for s0, s1 in zip(cuts, cuts[1:]):
                    sub = lab[s0:s1]
                    typ = "knock" if sum(sub) * 2 > len(sub) else "assist_knock"
                    k0, k1 = ks[s0], ks[s1 - 1]
                    if s0 == 0 and gi == 0:
                        k0 = i
                    out.append({"t": times[k0], "end": times[k1], "family": "P", "type": typ,
                                "product": "knock" if typ == "knock" else "assist",
                                "n": s1 - s0, "chev": float(np.median([frames[k].chev for k in ks[s0:s1]]))})
            i = last + 1
        elif cnt >= min_len:
            seg = [frames[k] for k in range(i, last + 1) if fam[k] in (c, "U")]
            typ = c
            if c == "G":
                typ = "squad_wipe" if np.median([f.line2_icons for f in seg]) >= 1 else "score_other"
            elif c == "SK":
                typ = "elim"
            elif c == "HD":
                typ = "assist_elim"
            product = {"knock": "knock", "assist_knock": "assist", "assist_elim": "assist"}.get(typ)
            out.append({"t": times[i], "end": times[last], "family": c, "type": typ, "product": product,
                        "n": cnt, "chev": float(np.median([f.chev for f in seg]))})
            i = last + 1
        else:
            i += 1
    return out
