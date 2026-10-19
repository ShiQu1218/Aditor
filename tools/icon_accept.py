"""驗收腳本：用完整引擎（analyze）跑影片，jobs=1／4 各一次，比對事件逐筆相同、與真值計分、報倍速。

用法：
  python tools/icon_accept.py --out DIR [--jobs 1 4] LAB=影片路徑 ...
真值（只用來評分，不用來調參）：
  TC／ENG／JP：舊文字引擎 after3 事件（ICON_ACCEPT_BASELINE 資料夾內 <LAB>_j1.json）＋ tools/icon_exp/truth_aug.json 的目視修正
  SC1：實驗報告的目視標註；SC2：實驗報告 §4.6 目視的 3 個事件
  H771／H950：沒有真值，只列事件數與舊文字引擎（ICON_ACCEPT_BASELINE 內 <LAB>_j1.json，若有）的對照
不寫入影片所在資料夾（快取在 --out 底下）。"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

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
        aug = json.loads((ROOT / "tools" / "icon_exp" / "truth_aug.json").read_text(encoding="utf-8"))[lab]
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
    ap.add_argument("videos", nargs="+", help="LAB=路徑")
    a = ap.parse_args()
    from aditor.analyze import analyze
    from aditor.probe import probe
    from aditor.profile import load_profile
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    base = Path(os.environ["ICON_ACCEPT_BASELINE"]) if os.environ.get("ICON_ACCEPT_BASELINE") else None
    prof = load_profile(ROOT / "templates" / "icons")
    for spec in a.videos:
        lab, path = spec.split("=", 1)
        dur = probe(path).duration
        docs = {}
        for j in a.jobs:
            t0 = time.time()
            doc = analyze(path, prof, cache_dir=out / f"cache_{lab}_j{j}", jobs=j, force=True)
            el = time.time() - t0
            docs[j] = doc
            (out / f"{lab}_j{j}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
            print(f"{lab} jobs={j}: {len(doc['events'])} 事件，h_scale={doc['analysis']['h_scale']}，"
                  f"{el:.1f} 秒（影片 {dur:.0f} 秒，{dur / el:.1f}x 倍速）", flush=True)
        view = {j: [(e["id"], e["t"], e["type"], e["name_sig"], e["counted"], e["counted_reason"]) for e in d["events"]]
                for j, d in docs.items()}
        first = a.jobs[0]
        for j in a.jobs[1:]:
            print(f"{lab} jobs={first} 與 jobs={j} 事件逐筆{'相同' if view[first] == view[j] else '不同！'}")
        pred = product(docs[first]["events"])
        tru = truth(lab, base)
        if tru is None:
            old = None
            if base and (base / f"{lab}_j1.json").exists():
                old = product(json.loads((base / f"{lab}_j1.json").read_text(encoding="utf-8"))["events"])
            print(f"{lab}: 圖示 K/A 事件 {len(pred)} 個（無真值）" + (f"；舊文字引擎 {len(old)} 個" if old is not None else ""))
            continue
        pairs, extra, missed = match(pred, tru)
        p2, extra2, missed2 = match([(t, "X") for t, _ in pred], [(t, "X") for t, _ in tru])
        kn = sum(1 for e in tru if e[1] == "K"), sum(1 for ei, _ in pairs if tru[ei][1] == "K")
        an = sum(1 for e in tru if e[1] == "A"), sum(1 for ei, _ in pairs if tru[ei][1] == "A")
        print(f"{lab}: 真值 {len(tru)}（K {kn[0]}／A {an[0]}）引擎 {len(pred)}；類型正確召回 {len(pairs)}/{len(tru)}="
              f"{len(pairs) / len(tru):.3f}（K {kn[1]}/{kn[0]}、A {an[1]}/{an[0]}）；不分類型召回 {len(p2)}/{len(tru)}="
              f"{len(p2) / len(tru):.3f}；精確度 類型正確 {len(pairs) / max(1, len(pred)):.3f} 不分類型 {len(p2) / max(1, len(pred)):.3f}")
        print(f"   漏報：{missed}")
        print(f"   多報：{extra}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
