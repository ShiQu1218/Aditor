"""Summarize completed fake-game runs using only the Python standard library."""

import argparse
import json
import math
import statistics
from pathlib import Path

METRICS = ("avg_fps", "low_1pct_fps", "low_01pct_fps", "stutters")


def component_breakdown(groups):
    components = (
        ("Electron app", "app_idle", "baseline"),
        ("Capture + small frames", "rec_capture", "baseline"),
        ("Video encode/mux/writes", "rec_encode", "rec_capture"),
        ("Audio capture/encode", "rec_audio", "rec_encode"),
        ("Live engine", "rec_live", "rec_audio"),
    )
    needed = {"record", "baseline", *(s for _, a, b in components for s in (a, b))}
    if not needed <= groups.keys():
        return []
    medians = {s: {k: statistics.median(r[k] for r in groups[s]) for k in METRICS[:3]}
               for s in needed}
    lines = ["", "## Component breakdown", "",
             "Signed FPS changes from scenario medians; negative means a cost. Shares divide "
             "each change by record minus baseline (the total recording drop). "
             "A zero total gives n/a; gains and negative shares are retained.", "",
             "| Component | Average FPS delta / share | 1% low delta / share | 0.1% low delta / share |",
             "| --- | ---: | ---: | ---: |"]
    for name, a, b in (*components, ("Unexplained remainder", None, None)):
        cells = []
        for key in METRICS[:3]:
            total = medians["record"][key] - medians["baseline"][key]
            delta = medians[a][key] - medians[b][key] if a else (
                medians["record"][key] - medians["rec_live"][key]
                - (medians["app_idle"][key] - medians["baseline"][key]))
            share = f"{delta / total * 100:+.2f}%" if total else "n/a"
            cells.append(f"{delta:+.2f} FPS / {share}")
        lines.append(f"| {name} | " + " | ".join(cells) + " |")
    lines += ["", "Deltas from medians of few runs are noisy. Components can interact, so shares "
              "are approximate; the remainder also includes app integration and finalization differences."]
    return lines


def summarize(root):
    groups = {}
    excluded = {}
    for file in sorted(root.glob("*/metadata.json")):
        meta = json.loads(file.read_text(encoding="utf-8-sig"))
        if meta.get("status") != "complete":
            continue
        stats = json.loads((file.parent / "stats.json").read_text(encoding="utf-8-sig"))
        if stats.get("background_frames", 0) > 0:
            scenario = meta["scenario"]
            excluded[scenario] = excluded.get(scenario, 0) + 1
            continue
        if any(not isinstance(stats.get(k), (int, float)) or not math.isfinite(stats[k])
               or stats[k] < 0 for k in METRICS):
            raise ValueError(f"Invalid stats: {file.parent}")
        groups.setdefault(meta["scenario"], []).append(stats)
    if not groups:
        raise ValueError("No completed runs" + (
            f" ({sum(excluded.values())} excluded for background_frames > 0)" if excluded else ""))
    baseline = groups.get("baseline")
    lines = ["# Fake-game frame-time benchmark", "",
             "Values are median [min, max] across completed runs. FPS deltas are percentages; "
             "stutter deltas are counts, relative to the baseline median.", "",
             "| Scenario | Runs | Average FPS | 1% low FPS | 0.1% low FPS | Stutters |",
             "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for scenario, runs in groups.items():
        cells = []
        for key in METRICS:
            values = [r[key] for r in runs]
            median = statistics.median(values)
            cell = f"{median:.2f} [{min(values):.2f}, {max(values):.2f}]"
            if baseline:
                base = statistics.median(r[key] for r in baseline)
                delta = f"{median - base:+.2f}" if key == "stutters" else (
                    f"{(median / base - 1) * 100:+.2f}%" if base else "n/a")
                cell += f" ({delta})"
            cells.append(cell)
        lines.append(f"| {scenario} | {len(runs)} | " + " | ".join(cells) + " |")
    lines += component_breakdown(groups)
    if excluded:
        counts = ", ".join(f"{s}: {n}" for s, n in excluded.items())
        lines += ["", f"Background runs excluded ({counts}): background_frames > 0; "
                  "game was not in the foreground (driver background frame-rate cap)."]
    incomplete = sum(json.loads(f.read_text(encoding="utf-8-sig")).get("status") != "complete"
                     for f in root.glob("*/metadata.json"))
    lines += ["", f"Incomplete/failed runs excluded: {incomplete}.", "",
              "Short smoke runs validate the pipeline only. Compare identical load, cap, clip, "
              "capture settings, and durations. These are Present submission intervals, not "
              "displayed-frame or GPU execution timings. Synthetic load does not predict real Apex FPS.", ""]
    return "\n".join(lines)


def self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for i, (scenario, fps) in enumerate((("baseline", 100), ("record", 80), ("record", 90))):
            run = root / str(i)
            run.mkdir()
            (run / "metadata.json").write_text(json.dumps(dict(status="complete", scenario=scenario)))
            (run / "stats.json").write_text(json.dumps(dict.fromkeys(METRICS, fps)))
        report = summarize(root)
        assert "85.00 [80.00, 90.00] (-15.00%)" in report
        assert "85.00 [80.00, 90.00] (-15.00)" in report
        assert "Background runs excluded" not in report
        for i, scenario in enumerate(("baseline", "record", "record", "app_idle"), start=3):
            run = root / str(i)
            run.mkdir()
            (run / "metadata.json").write_text(json.dumps(dict(status="complete", scenario=scenario)))
            (run / "stats.json").write_text(json.dumps(dict.fromkeys(METRICS, 1) | {"background_frames": 1}))
        (root / "1" / "stats.json").write_text(json.dumps(dict.fromkeys(METRICS, 80) | {"background_frames": 0}))
        report = summarize(root)
        assert "85.00 [80.00, 90.00] (-15.00%)" in report
        assert "Background runs excluded (baseline: 1, record: 2, app_idle: 1): background_frames > 0" in report
        assert "| app_idle |" not in report
        (root / "2" / "metadata.json").write_text('{"status":"failed"}')
        assert "Incomplete/failed runs excluded: 1" in summarize(root)
        (root / "0" / "stats.json").write_text('{"avg_fps": -1}')
        try:
            summarize(root)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid stats accepted")
    groups = {s: [dict.fromkeys(METRICS, fps)] for s, fps in (
        ("baseline", 100), ("record", 80), ("app_idle", 98), ("rec_capture", 97),
        ("rec_encode", 91), ("rec_audio", 90), ("rec_live", 85))}
    groups["record"].append(dict.fromkeys(METRICS, 82))  # Median 81, total drop 19.
    breakdown = "\n".join(component_breakdown(groups))
    assert "-2.00 FPS / +10.53%" in breakdown
    assert "-6.00 FPS / +31.58%" in breakdown
    assert "-5.00 FPS / +26.32%" in breakdown
    assert "| Unexplained remainder | -2.00 FPS / +10.53%" in breakdown
    assert breakdown.count("-2.00 FPS / +10.53%") == 6
    groups["record"] = groups["baseline"]
    assert "FPS / n/a" in "\n".join(component_breakdown(groups))
    groups["rec_audio"] = [dict.fromkeys(METRICS, 92)]
    groups["record"] = [dict.fromkeys(METRICS, 80)]
    assert "+1.00 FPS / -5.00%" in "\n".join(component_breakdown(groups))
    del groups["rec_live"]
    assert not component_breakdown(groups)
    print("summarizer self-test passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        if args.results is None:
            parser.error("results directory required")
        report = summarize(args.results)
        (args.results / "summary.md").write_text(report, encoding="utf-8", newline="\n")
        print(report)
