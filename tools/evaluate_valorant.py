"""Read-only visual-tracking regression on local recordings, without analysis-cache writes.

Compare against a saved visual baseline and manually reviewed HUD timestamps.
Audio is never read. Clip labels describe visible kill cues, not bullet-hit times.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

from engine_cli import ROOT, json_lines


def match_events(truth: list[float], predicted: list[float], tolerance: float) -> dict:
    actual, found = sorted(truth), sorted(predicted)
    n, m = len(actual), len(found)
    dp = [[(0, 0.0) for _ in range(m + 1)] for _ in range(n + 1)]
    action = [[None for _ in range(m + 1)] for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best, how = max((dp[i - 1][j], "truth"), (dp[i][j - 1], "pred"), key=lambda x: x[0])
            error = abs(actual[i - 1] - found[j - 1])
            if error <= tolerance:
                previous = dp[i - 1][j - 1]
                candidate = (previous[0] + 1, previous[1] - error)
                if candidate >= best:
                    best, how = candidate, "pair"
            dp[i][j], action[i][j] = best, how
    pairs = []
    i, j = n, m
    while i and j:
        if action[i][j] == "pair":
            pairs.append({"truth": actual[i - 1], "predicted": found[j - 1],
                          "error": round(found[j - 1] - actual[i - 1], 4)})
            i, j = i - 1, j - 1
        elif action[i][j] == "truth":
            i -= 1
        else:
            j -= 1
    tp = len(pairs)
    return {"truth": n, "predicted": m, "tp": tp, "fp": m - tp, "fn": n - tp,
            "pairs": list(reversed(pairs))}


def evaluate(truth_doc: dict, videos: list[dict], tolerance: float) -> dict:
    results = []
    for window in truth_doc["windows"]:
        video = next((v for v in videos if v["filename"] == window["filename"]), None)
        if video is None:
            raise SystemExit(f"No analysis result for {window['filename']} (window {window['id']})")
        times = [e["t"] for e in video["events"] if e.get("type", "kill") == "kill"
                 and window["start"] <= e["t"] < window["end"]]
        result = match_events([e["t"] for e in window["kills"]], times, tolerance)
        results.append({"id": window["id"], **result})
    return {"tp": sum(r["tp"] for r in results), "fp": sum(r["fp"] for r in results),
            "fn": sum(r["fn"] for r in results), "windows": results}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video-root", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--truth", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    truth = json.loads(args.truth.read_text(encoding="utf-8"))
    profile_dir = ROOT / "templates/valorant/icons"
    version = json.loads((profile_dir / "profile.json").read_text(encoding="utf-8"))["templates_version"]
    report = {"templates_version": version, "baseline": baseline["source"], "videos": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for path in sorted(args.video_root.glob("*.mp4")):
        started = time.perf_counter()
        events = []
        for frame in json_lines("debug-valorant-feed", path, "--profile-dir", profile_dir):
            events = [{"id": e["id"], "t": e["t"], "type": e["type"]} for e in frame["events"]]
        report["videos"].append({"filename": path.name, "events": events,
                                  "seconds": time.perf_counter() - started})
        print(json.dumps({"filename": path.name, "kills": sum(e["type"] == "kill" for e in events)},
                         ensure_ascii=True), flush=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    report["metrics"] = {str(tol): {"before": evaluate(truth, baseline["videos"], tol),
                                     "after": evaluate(truth, report["videos"], tol)} for tol in (0.5, 1.5)}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({tol: {arm: {k: r[k] for k in ("tp", "fp", "fn")}
                           for arm, r in values.items()} for tol, values in report["metrics"].items()}), flush=True)


if __name__ == "__main__":
    main()
