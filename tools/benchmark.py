"""Performance benchmark (spec §8): analyze the first N seconds with hwaccel on/off and report video seconds per wall-clock second.

Usage: python tools/benchmark.py <video> [--seconds 600] [--start 0] [--jobs N] [--hw-only]

--jobs N: Split [start, start+seconds] evenly into N segments, each decoded concurrently by its own engine subprocess (parallel segmentation as in analyze).

Measures only decoding and per-frame detection (excluding calibration and keyframes). AV1 software decoding represents a worst case for low-end computers.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

DEFAULT_PROFILE = Path(__file__).resolve().parents[1] / "templates" / "icons"


def run_once(video: str, profile, seconds: float, start: float, hwaccel: bool) -> dict:
    from engine_cli import json_lines
    args = ["debug-benchmark", video, "--profile-dir", profile, "--seconds", seconds, "--start", start]
    if not hwaccel:
        args.append("--no-hwaccel")
    result, = json_lines(*args)
    return result


def run_segments(video: str, profile, seconds: float, start: float, jobs: int) -> dict:
    from concurrent.futures import ThreadPoolExecutor
    seg = seconds / jobs
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        results = list(pool.map(lambda i: run_once(video, profile, seg, start + i * seg, True), range(jobs)))
    wall = time.perf_counter() - t0
    video_s = sum(r["video_s"] for r in results)
    return {"hwaccel": True, "used_hwaccel": all(r["used_hwaccel"] for r in results),
            "frames": sum(r["frames"] for r in results), "video_s": video_s, "wall_s": wall,
            "startup_s": max(r["startup_s"] for r in results), "speed": video_s / wall}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Benchmark speed with hwaccel on and off")
    ap.add_argument("video")
    ap.add_argument("--seconds", type=float, default=600.0)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--hw-only", action="store_true", help="Measure only the hardware path")
    ap.add_argument("--profile-dir", default=str(DEFAULT_PROFILE))
    a = ap.parse_args(argv)
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    if a.jobs < 1 or a.seconds <= 0 or a.start < 0:
        ap.error("jobs/seconds must be positive and start nonnegative")
    profile = Path(a.profile_dir)
    for hw in ((True,) if a.hw_only else (True, False)):
        if hw and a.jobs > 1:
            r = run_segments(a.video, profile, a.seconds, a.start, a.jobs)
        else:
            r = run_once(a.video, profile, a.seconds, a.start, hw)
        label = f"Hardware jobs={a.jobs}" if hw else "Software decode"
        note = "" if r["used_hwaccel"] == hw else " (hardware decoding failed; fell back to software)"
        print(f"{label}: {r['video_s']:.1f} s video / {r['wall_s']:.1f} s elapsed = "
              f"{r['speed']:.2f}x realtime ({r['frames']} frames, {r['startup_s']:.1f} s startup){note}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
