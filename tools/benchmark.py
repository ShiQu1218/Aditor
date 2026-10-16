"""速度基準（spec §8）：以 hwaccel 開／關分析前 N 秒，輸出「影片秒數 / 實際秒數」倍速。

用法：python tools/benchmark.py <video> [--seconds 600] [--start 0] [--jobs N] [--hw-only]

--jobs N：把 [start, start+seconds] 平均切成 N 段，各用一個 FrameStream 並行解碼（同 analyze 的切段平行）。

只量測解碼＋逐格偵測迴圈（不含校準與 keyframes）。AV1 軟體解碼視為低階電腦最差情況。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

DEFAULT_PROFILE = Path(__file__).resolve().parents[1] / "templates" / "zh-TW"


def run_once(video: str, profile, seconds: float, start: float, hwaccel: bool,
             codec: str | None = None) -> dict:
    from apexhl.decode import FrameStream
    from apexhl.detect import Detector

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
    from apexhl.decode import FrameStream
    from apexhl.detect import Detector

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
    ap = argparse.ArgumentParser(description="hwaccel 開／關速度基準")
    ap.add_argument("video")
    ap.add_argument("--seconds", type=float, default=600.0)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--hw-only", action="store_true", help="只量測硬體路徑")
    ap.add_argument("--profile-dir", default=str(DEFAULT_PROFILE))
    a = ap.parse_args(argv)
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    from apexhl.profile import load_profile
    profile = load_profile(Path(a.profile_dir))
    from apexhl.probe import probe
    codec = probe(a.video).codec
    for hw in ((True,) if a.hw_only else (True, False)):
        if hw and a.jobs > 1:
            r = run_segments(a.video, profile, a.seconds, a.start, a.jobs, codec)
        else:
            r = run_once(a.video, profile, a.seconds, a.start, hw, codec)
        label = f"硬體 jobs={a.jobs}" if hw else "軟體解碼  "
        note = "" if r["used_hwaccel"] == hw else "（硬體解碼失敗，已退回軟體）"
        print(f"{label}：影片 {r['video_s']:.1f} 秒 / 實際 {r['wall_s']:.1f} 秒 = "
              f"{r['speed']:.2f}x 即時（{r['frames']} 格，啟動 {r['startup_s']:.1f} 秒）{note}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
