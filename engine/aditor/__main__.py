"""命令列入口：python -m aditor analyze|matches|ipc|live。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _cmd_analyze(a) -> int:
    from aditor.analyze import analyze
    from aditor.profile import load_profile

    profile = load_profile(Path(a.profile_dir))

    def progress(t: float, duration: float) -> None:
        pct = 100.0 * t / duration if duration > 0 else 0.0
        print(f"\r分析中 {t:8.1f} / {duration:.1f} 秒 ({pct:5.1f}%)", end="", file=sys.stderr, flush=True)

    doc = analyze(a.video, profile, cache_dir=Path(a.cache_dir), force=a.force,
                  on_progress=progress, hwaccel=not a.no_hwaccel, jobs=a.jobs)
    print(file=sys.stderr)
    if a.out:
        Path(a.out).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    counted = sum(1 for e in doc["events"]
                  if not e["deleted"] and (e["counted_override"] if e["counted_override"] is not None
                                           else e["counted"]))
    print(f"事件 {len(doc['events'])} 個（計入 {counted}），快取：{doc['cache_path']}")
    return 0


def _cmd_matches(a) -> int:
    from aditor.matches import analyze_matches

    doc = analyze_matches(a.video, fps=a.fps, timeline=a.timeline, hwaccel=not a.no_hwaccel)
    print(json.dumps(doc, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="aditor")
    sub = ap.add_subparsers(dest="cmd", required=True)
    an = sub.add_parser("analyze", help="分析影片")
    an.add_argument("video")
    an.add_argument("--profile-dir", required=True)
    an.add_argument("--cache-dir", required=True)
    an.add_argument("--force", action="store_true")
    an.add_argument("--no-hwaccel", action="store_true")
    an.add_argument("--jobs", type=int, default=None, help="切段平行解碼的段數（預設自動）")
    an.add_argument("--out")
    ma = sub.add_parser("matches", help="偵測影片中的對局起訖")
    ma.add_argument("video")
    ma.add_argument("--fps", type=float, default=1.0)
    ma.add_argument("--timeline", action="store_true", help="包含逐格場景時間軸")
    ma.add_argument("--no-hwaccel", action="store_true")
    sub.add_parser("ipc", help="JSON Lines IPC 伺服器")
    li = sub.add_parser("live", help="即時偵測（讀 aditorrec 共享記憶體，stdout 輸出 JSON Lines）")
    li.add_argument("--shm", required=True, help="共享記憶體名稱（例如 Local\\aditorrec-<sessionId>）")
    li.add_argument("--profile-dir", required=True, help="圖示範本目錄（templates/icons）")
    li.add_argument("--scene-dir", default=None, help="場景範本目錄（預設 templates/scene）")
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    a = ap.parse_args(argv)
    if a.cmd == "ipc":
        from aditor.ipc import run
        return run()
    if a.cmd == "live":
        from aditor.live import run as run_live
        return run_live(a.shm, Path(a.profile_dir), Path(a.scene_dir) if a.scene_dir else None)
    try:
        if a.cmd == "matches":
            return _cmd_matches(a)
        return _cmd_analyze(a)
    except Exception as e:  # noqa: BLE001
        print(f"錯誤：{e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
