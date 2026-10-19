"""Performance benchmark (spec §8): analyze the first N seconds with hwaccel on/off and report video seconds per wall-clock second.

Usage: python tools/benchmark.py <video> [--seconds 600] [--start 0] [--jobs N] [--hw-only]

--jobs N: Split [start, start+seconds] evenly into N segments, each decoded concurrently by its own FrameStream (parallel segmentation as in analyze).

Measures only decoding and per-frame detection (excluding calibration and keyframes). AV1 software decoding represents a worst case for low-end computers.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

DEFAULT_PROFILE = Path(__file__).resolve().parents[1] / "templates" / "icons"


def run_once(video: str, profile, seconds: float, start: float, hwaccel: bool,
             codec: str | None = None) -> dict:
    from aditor.decode import FrameStream
    from aditor.detect import Detector

    detector = Detector(profile, 1.0)
    stream = FrameStream(video, profile, start=start, hwaccel=hwaccel, codec=codec)
    t0 = time.perf_counter()
    first = None
    last_t = start
    frames = 0
    try:
        for t, banner, spec in stream:
            if first is None:
                first = time.perf_counter()
            detector.detect(banner, spec)
            last_t = t
            frames += 1
            if t - start >= seconds:
                break
    finally:
        stream.close()
    wall = time.perf_counter() - t0
    video_s = last_t - start + 0.25
    return {"hwaccel": hwaccel, "used_hwaccel": stream.used_hwaccel, "frames": frames,
            "video_s": video_s, "wall_s": wall, "startup_s": (first or t0) - t0,
            "speed": video_s / wall if wall > 0 else 0.0}


def run_segments(video: str, profile, seconds: float, start: float, jobs: int,
                 codec: str | None = None) -> dict:
    from concurrent.futures import ThreadPoolExecutor
    from aditor.decode import FrameStream
    from aditor.detect import Detector

    seg = seconds / jobs

    used: list[bool] = []

    def work(i: int) -> int:
        s0 = start + i * seg
        detector = Detector(profile, 1.0)
        stream = FrameStream(video, profile, start=s0, end=s0 + seg, hwaccel=True, codec=codec)
        n = 0
        try:
            for _t, banner, spec in stream:
                detector.detect(banner, spec)
                n += 1
        finally:
            used.append(stream.used_hwaccel)
            stream.close()
        return n

    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=jobs) as ex:
        frames = sum(ex.map(work, range(jobs)))
    wall = time.perf_counter() - t0
    video_s = frames * 0.25
    return {"hwaccel": True, "used_hwaccel": all(used), "frames": frames, "video_s": video_s, "wall_s": wall,
            "startup_s": 0.0, "speed": video_s / wall if wall > 0 else 0.0}


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
    from aditor.profile import load_profile
    profile = load_profile(Path(a.profile_dir))
    from aditor.probe import probe
    codec = probe(a.video).codec
    for hw in ((True,) if a.hw_only else (True, False)):
        if hw and a.jobs > 1:
            r = run_segments(a.video, profile, a.seconds, a.start, a.jobs, codec)
        else:
            r = run_once(a.video, profile, a.seconds, a.start, hw, codec)
        label = f"Hardware jobs={a.jobs}" if hw else "Software decode"
        note = "" if r["used_hwaccel"] == hw else " (hardware decoding failed; fell back to software)"
        print(f"{label}: {r['video_s']:.1f} s video / {r['wall_s']:.1f} s elapsed = "
              f"{r['speed']:.2f}x realtime ({r['frames']} frames, {r['startup_s']:.1f} s startup){note}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
