"""Command-line entry point: python -m aditor analyze|matches|ipc|live."""
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
        print(f"\rAnalyzing {t:8.1f} / {duration:.1f} seconds ({pct:5.1f}%)", end="", file=sys.stderr, flush=True)

    doc = analyze(a.video, profile, cache_dir=Path(a.cache_dir), force=a.force,
                  on_progress=progress, hwaccel=not a.no_hwaccel, jobs=a.jobs, layout=_layout(a))
    print(file=sys.stderr)
    if a.out:
        Path(a.out).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    counted = sum(1 for e in doc["events"]
                  if not e["deleted"] and (e["counted_override"] if e["counted_override"] is not None
                                           else e["counted"]))
    print(f"{len(doc['events'])} events ({counted} counted), cache: {doc['cache_path']}")
    return 0


def _cmd_matches(a) -> int:
    from aditor.matches import analyze_matches

    doc = analyze_matches(a.video, fps=a.fps, timeline=a.timeline, hwaccel=not a.no_hwaccel, layout=_layout(a),
                          scene_dir=Path(a.scene_dir) if a.scene_dir else None)
    print(json.dumps(doc, ensure_ascii=False))
    return 0


def _layout(a):
    from aditor.layout import parse_aspect
    return parse_aspect(a.aspect) if a.aspect else None


ASPECT_HELP = "Game render aspect or resolution (16:9, 16:10, 4:3, 5:4, or WxH); offline default: video metadata, otherwise 16:9"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="aditor")
    sub = ap.add_subparsers(dest="cmd", required=True)
    an = sub.add_parser("analyze", help="Analyze a video")
    an.add_argument("video")
    an.add_argument("--profile-dir", required=True)
    an.add_argument("--cache-dir", required=True)
    an.add_argument("--force", action="store_true")
    an.add_argument("--no-hwaccel", action="store_true")
    an.add_argument("--jobs", type=int, default=None, help="Number of segments to decode in parallel (automatic by default)")
    an.add_argument("--out")
    an.add_argument("--aspect", default=None, help=ASPECT_HELP)
    ma = sub.add_parser("matches", help="Detect match start and end times in a video")
    ma.add_argument("video")
    ma.add_argument("--fps", type=float, default=1.0)
    ma.add_argument("--timeline", action="store_true", help="Include a per-frame scene timeline")
    ma.add_argument("--no-hwaccel", action="store_true")
    ma.add_argument("--aspect", default=None, help=ASPECT_HELP)
    ma.add_argument("--scene-dir", default=None, help="Scene template directory (default: templates/scene)")
    sub.add_parser("ipc", help="JSON Lines IPC server")
    li = sub.add_parser("live", help="Live detection (reads aditorrec shared memory and writes JSON Lines to stdout)")
    li.add_argument("--shm", required=True, help="Shared memory name (for example, Local\\aditorrec-<sessionId>)")
    li.add_argument("--profile-dir", required=True, help="Icon template directory (templates/icons)")
    li.add_argument("--scene-dir", default=None, help="Scene template directory (default: templates/scene)")
    li.add_argument("--aspect", default=None, help=ASPECT_HELP)
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    a = ap.parse_args(argv)
    if a.cmd == "ipc":
        from aditor.ipc import run
        return run()
    if a.cmd == "live":
        from aditor.live import run as run_live
        return run_live(a.shm, Path(a.profile_dir), Path(a.scene_dir) if a.scene_dir else None, aspect=a.aspect)
    try:
        if a.cmd == "matches":
            return _cmd_matches(a)
        return _cmd_analyze(a)
    except Exception as e:  # noqa: BLE001
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
