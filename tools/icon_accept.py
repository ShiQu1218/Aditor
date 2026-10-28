"""Acceptance script: analyze videos with the full engine, compare per-event results across jobs=1/4, score against ground truth, and report speed.

Usage:
  python tools/icon_accept.py --out DIR [--jobs 1 4] LAB=video_path ...
Ground truth (used only for scoring, not parameter tuning):
  TC/ENG/JP: old text engine after3 events (the <LAB>_j1.json file in ICON_ACCEPT_BASELINE) plus visual corrections in tools/archive/icon_exp/truth_aug.json
  SC1: visual annotations from the experiment report; SC2: the 3 events visually identified in experiment report §4.6
  H771/H950: no ground truth; show event counts and compare with the old text engine, if <LAB>_j1.json exists in ICON_ACCEPT_BASELINE
Does not write to the video directory (cache is stored under --out)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
from engine_cli import analyze

PM = {"knock": "K", "assist_knock": "A", "assist_elim": "A"}
SC1 = [(312.25, "K"), (315.0, "K"), (334.0, "K"), (354.5, "K"), (577.75, "K"), (672.75, "K"), (685.25, "K"),
       (296.75, "A"), (357.25, "A"), (364.25, "A")]
SC2 = [(307.25, "K"), (456.0, "K"), (568.0, "A")]


def product(events: list[dict]) -> list[tuple[float, str]]:
    return sorted((e["t"], PM[e["type"]]) for e in events if e["type"] in PM)


def truth(lab: str, base: Path | None) -> list[tuple[float, str]] | None:
    if lab == "SC1":
        return sorted(SC1)
    if lab == "SC2":
        return sorted(SC2)
    if lab in ("TC", "ENG", "JP") and base and (base / f"{lab}_j1.json").exists():
        ev = product(json.loads((base / f"{lab}_j1.json").read_text(encoding="utf-8"))["events"])
        aug = json.loads((ROOT / "tools" / "archive" / "icon_exp" / "truth_aug.json").read_text(encoding="utf-8"))[lab]
        mv = {o: n for o, n in aug["move"]}
        rt = {t: c for t, c in aug["retype"]}
        return sorted([(mv.get(t, t), rt.get(t, c)) for t, c in ev] + [tuple(x) for x in aug["add"]])
    return None


def match(pred, tru, tol=1.5, typed=True):
    used, pairs = set(), []
    for ei, (t, c) in enumerate(tru):
        best = None
        for ri, (pt, pc) in enumerate(pred):
            if ri in used or (typed and pc != c):
                continue
            d = abs(pt - t)
            if d <= tol and (best is None or d < best[0]):
                best = (d, ri)
        if best:
            used.add(best[1])
            pairs.append((ei, best[1]))
    return pairs, [p for i, p in enumerate(pred) if i not in used], [tru[i] for i in range(len(tru)) if i not in {p[0] for p in pairs}]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--jobs", type=int, nargs="+", default=[1, 4])
    ap.add_argument("videos", nargs="+", help="LAB=path")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    base = Path(os.environ["ICON_ACCEPT_BASELINE"]) if os.environ.get("ICON_ACCEPT_BASELINE") else None
    prof = ROOT / "templates" / "icons"
    for spec in a.videos:
        lab, path = spec.split("=", 1)
        docs = {}
        for j in a.jobs:
            t0 = time.time()
            doc = analyze(path, prof, out / f"cache_{lab}_j{j}", out / f"{lab}_j{j}.json", jobs=j)
            dur = doc["video"]["duration"]
            el = time.time() - t0
            docs[j] = doc
            (out / f"{lab}_j{j}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
            print(f"{lab} jobs={j}: {len(doc['events'])} events, h_scale={doc['analysis']['h_scale']}, "
                  f"{el:.1f} s (video {dur:.0f} s, {dur / el:.1f}x realtime)", flush=True)
        view = {j: [(e["id"], e["t"], e["type"], e["name_sig"], e["counted"], e["counted_reason"]) for e in d["events"]]
                for j, d in docs.items()}
        first = a.jobs[0]
        for j in a.jobs[1:]:
            print(f"{lab} jobs={first} vs. jobs={j}: events are {'identical' if view[first] == view[j] else 'different!'}")
        pred = product(docs[first]["events"])
        tru = truth(lab, base)
        if tru is None:
            old = None
            if base and (base / f"{lab}_j1.json").exists():
                old = product(json.loads((base / f"{lab}_j1.json").read_text(encoding="utf-8"))["events"])
            print(f"{lab}: {len(pred)} icon K/A events (no ground truth)" + (f"; {len(old)} old text-engine events" if old is not None else ""))
            continue
        pairs, extra, missed = match(pred, tru)
        p2, extra2, missed2 = match([(t, "X") for t, _ in pred], [(t, "X") for t, _ in tru])
        kn = sum(1 for e in tru if e[1] == "K"), sum(1 for ei, _ in pairs if tru[ei][1] == "K")
        an = sum(1 for e in tru if e[1] == "A"), sum(1 for ei, _ in pairs if tru[ei][1] == "A")
        print(f"{lab}: {len(tru)} ground-truth events (K {kn[0]}/A {an[0]}), {len(pred)} engine events; typed recall {len(pairs)}/{len(tru)}="
              f"{len(pairs) / len(tru):.3f} (K {kn[1]}/{kn[0]}, A {an[1]}/{an[0]}); untyped recall {len(p2)}/{len(tru)}="
              f"{len(p2) / len(tru):.3f}; precision typed {len(pairs) / max(1, len(pred)):.3f}, untyped {len(p2) / max(1, len(pred)):.3f}")
        print(f"   Missed: {missed}")
        print(f"   Extra: {extra}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
