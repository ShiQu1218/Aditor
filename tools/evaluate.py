"""準確率評估（spec §8）：以真值與快取預測計算各類型召回率／精確率與漏抓、誤抓清單。

用法：python tools/evaluate.py --truth truth.json --pred cache.json [--tolerance 1.5] [--types knock]

流程：以「同類型最近配對」的時間差中位數估計系統性偏移並從預測扣除，再以貪婪最近配對
（時間差 <= tolerance）計算 TP／FP／FN。預測只取「最終計入」的事件（counted_override ?? counted，
排除 deleted）。真值類型對應：knock -> knock、assist -> assist（預測的 assist_knock／assist_elim 皆視為
assist）、kill -> elim。
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path

MAX_OFFSET = 2.0     # 系統性偏移補償上限（秒）：超過者不補償，直接反映成漏抓／誤抓（M8）
OFFSET_WINDOW = 5.0  # 估計偏移時，只看此範圍內的最近配對（秒）

TRUTH_TYPE_MAP = {"knock": "knock", "assist": "assist", "kill": "elim",
                  "knockdown": "knock", "elim": "elim"}
PRED_TYPE_MAP = {"knock": "knock", "assist_knock": "assist", "assist_elim": "assist",
                 "elim": "elim", "squad_wipe": "squad_wipe"}


@dataclass
class TypeStats:
    type: str
    truth: int = 0
    pred: int = 0
    tp: int = 0
    offset: float = 0.0       # 實際扣除的偏移
    raw_offset: float = 0.0   # 估計出的原始偏移（可能超過上限而未扣除）
    missed: list[float] = field(default_factory=list)   # 真值時間（未偵測到）
    false: list[float] = field(default_factory=list)    # 預測原始時間（無對應真值）

    @property
    def recall(self) -> float:
        return self.tp / self.truth if self.truth else 1.0

    @property
    def precision(self) -> float:
        return self.tp / self.pred if self.pred else 1.0


@dataclass
class Report:
    offset: float
    types: dict[str, TypeStats]


def _estimate_offset(truth: list[float], pred: list[float]) -> float:
    diffs = []
    for t in truth:
        if not pred:
            break
        p = min(pred, key=lambda x: abs(x - t))
        if abs(p - t) <= OFFSET_WINDOW:
            diffs.append(p - t)
    return statistics.median(diffs) if diffs else 0.0


def _match(truth: list[float], pred: list[float], tolerance: float) -> list[tuple[int, int]]:
    cands = sorted((abs(p - t), i, j) for i, t in enumerate(truth) for j, p in enumerate(pred)
                   if abs(p - t) <= tolerance)
    used_t: set[int] = set()
    used_p: set[int] = set()
    pairs = []
    for _, i, j in cands:
        if i in used_t or j in used_p:
            continue
        used_t.add(i)
        used_p.add(j)
        pairs.append((i, j))
    return pairs


def evaluate(truth: list[tuple[float, str]], pred: list[tuple[float, str]],
             tolerance: float = 1.5, max_offset: float = MAX_OFFSET) -> Report:
    """truth／pred 皆為 (時間秒, 類型)。"""
    names = sorted({k for _, k in truth} | {k for _, k in pred})
    types: dict[str, TypeStats] = {}
    all_diffs: list[float] = []
    for name in names:
        tt = sorted(t for t, k in truth if k == name)
        pp = sorted(t for t, k in pred if k == name)
        raw = _estimate_offset(tt, pp)
        off = raw if abs(raw) <= max_offset else 0.0  # 偏移過大是 bug 不是校正對象
        shifted = [p - off for p in pp]
        pairs = _match(tt, shifted, tolerance)
        st = TypeStats(name, truth=len(tt), pred=len(pp), tp=len(pairs), offset=off, raw_offset=raw)
        mt = {i for i, _ in pairs}
        mp = {j for _, j in pairs}
        st.missed = [t for i, t in enumerate(tt) if i not in mt]
        st.false = [p for j, p in enumerate(pp) if j not in mp]
        types[name] = st
        all_diffs += [pp[j] - tt[i] for i, j in pairs]
    offset = statistics.median(all_diffs) if all_diffs else 0.0
    return Report(offset=offset, types=types)


def hms(t: float) -> str:
    s = int(round(t))
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def load_truth(path: Path) -> list[tuple[float, str]]:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    return [(float(e["t"]), TRUTH_TYPE_MAP.get(e["type"], e["type"])) for e in doc["events"]]


def final_counted(e: dict) -> bool:
    if e.get("deleted"):
        return False
    ov = e.get("counted_override")
    return bool(ov if ov is not None else e.get("counted"))


def load_pred(path: Path) -> list[tuple[float, str]]:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    return [(float(e["t"]), PRED_TYPE_MAP.get(e["type"], e["type"]))
            for e in doc["events"] if final_counted(e)]


def spectating_filtered_matches(truth_path: Path, pred_path: Path, tolerance: float,
                                offset: float) -> list[tuple[float, str]]:
    """被觀戰過濾（counted=false, spectating）但其實對得上真值的事件：觀戰過濾的錯殺。"""
    truth = load_truth(truth_path)
    doc = json.loads(Path(pred_path).read_text(encoding="utf-8"))
    out = []
    for e in doc["events"]:
        if e.get("deleted") or e.get("counted_reason") != "spectating":
            continue
        k = PRED_TYPE_MAP.get(e["type"], e["type"])
        if any(k == tk and abs((e["t"] - offset) - tt) <= tolerance for tt, tk in truth):
            out.append((float(e["t"]), k))
    return out


def format_report(rep: Report, types: list[str] | None) -> str:
    lines = [f"估計系統性偏移（預測 - 真值，中位數）：{rep.offset:+.2f} 秒"]
    for name, st in rep.types.items():
        if types and name not in types:
            continue
        lines.append(f"[{name}] 真值 {st.truth} 預測 {st.pred} 命中 {st.tp} "
                     f"召回率 {st.recall:.1%} 精確率 {st.precision:.1%} 偏移 {st.raw_offset:+.2f}s"
                     + ("（超過上限，未補償）" if st.raw_offset != st.offset else ""))
        if st.missed:
            lines.append("  漏抓：" + " ".join(hms(t) for t in st.missed))
        if st.false:
            lines.append("  誤抓：" + " ".join(hms(t) for t in st.false))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="評估偵測準確率")
    ap.add_argument("--truth", required=True)
    ap.add_argument("--pred", required=True)
    ap.add_argument("--tolerance", type=float, default=1.5)
    ap.add_argument("--types", nargs="+", default=["knock"])
    a = ap.parse_args(argv)
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    truth, pred = load_truth(Path(a.truth)), load_pred(Path(a.pred))
    rep = evaluate(truth, pred, a.tolerance)
    print(format_report(rep, a.types))
    wrong = spectating_filtered_matches(Path(a.truth), Path(a.pred), a.tolerance, rep.offset)
    if wrong:
        print("觀戰過濾錯殺（對得上真值卻被標為觀戰）：" + " ".join(f"{hms(t)}({k})" for t, k in wrong))
    return 0


if __name__ == "__main__":
    sys.exit(main())
