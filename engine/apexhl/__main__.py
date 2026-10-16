"""命令列入口：python -m apexhl analyze|ipc。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _cmd_analyze(a) -> int:
    from apexhl.analyze import analyze
    from apexhl.profile import resolve_profiles

    profiles = resolve_profiles(Path(a.profile_dir))
    profile_arg = profiles[0] if len(profiles) == 1 else profiles

    def progress(t: float, duration: float) -> None:
        pct = 100.0 * t / duration if duration > 0 else 0.0
        print(f"\r分析中 {t:8.1f} / {duration:.1f} 秒 ({pct:5.1f}%)", end="", file=sys.stderr, flush=True)

    doc = analyze(a.video, profile_arg, cache_dir=Path(a.cache_dir), force=a.force,
                  on_progress=progress, hwaccel=not a.no_hwaccel, jobs=a.jobs)
    print(file=sys.stderr)
    if a.out:
        Path(a.out).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    counted = sum(1 for e in doc["events"]
                  if not e["deleted"] and (e["counted_override"] if e["counted_override"] is not None
                                           else e["counted"]))
    print(f"事件 {len(doc['events'])} 個（計入 {counted}），快取：{doc['cache_path']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="apexhl")
    sub = ap.add_subparsers(dest="cmd", required=True)
    an = sub.add_parser("analyze", help="分析影片")
    an.add_argument("video")
    an.add_argument("--profile-dir", required=True)
    an.add_argument("--cache-dir", required=True)
    an.add_argument("--force", action="store_true")
    an.add_argument("--no-hwaccel", action="store_true")
    an.add_argument("--jobs", type=int, default=None, help="切段平行解碼的段數（預設自動）")
    an.add_argument("--out")
    sub.add_parser("ipc", help="JSON Lines IPC 伺服器")
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    a = ap.parse_args(argv)
    if a.cmd == "ipc":
        from apexhl.ipc import run
        return run()
    try:
        return _cmd_analyze(a)
    except Exception as e:  # noqa: BLE001
        print(f"錯誤：{e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
