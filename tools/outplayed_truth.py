"""Export ground truth from Outplayed's IndexedDB (spec §8).

Usage: python tools/outplayed_truth.py --out truth_dir [--idb <leveldb directory>] [--video <video path> ...]

- Copy the entire leveldb directory to a temporary location before reading it (to avoid file locks or modifying the source data).
- Read match records with ccl_chromium_reader (including medias[].events); for each video whose file still exists and has events, write
  `<video filename>.truth.json`: {"video": filename, "events": [{"t": seconds, "type": "knock"|"assist"|"kill"|...}]}.
- Event time is in milliseconds relative to the start of that media (video). Divide by 1000 to get seconds from the start of the video.
  (Outplayed exports have media.startTime set to 0; evaluate estimates the fixed offset from the on-screen banner using the median.)
- Videos without events (for example, long recordings made while the Overwolf event service was down, marked isServiceDown) are omitted to avoid misleading empty ground truth.
- Print the reason and exit with a nonzero status if parsing fails.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

DEFAULT_IDB = (r"%LOCALAPPDATA%\Overwolf\CefBrowserCache\Default\IndexedDB\overwolf-extension_"
               r"cghphpbjeabdkomiphingnegihoigeggcfphdofo_0.indexeddb.leveldb")
TYPE_MAP = {"knockdown": "knock", "assist": "assist", "kill": "kill"}

EXIT_NO_TRUTH = 3
EXIT_UNREADABLE = 2


def read_matches(leveldb_dir: Path) -> list[dict]:
    """Return all match records (dictionaries containing medias)."""
    from ccl_chromium_reader import ccl_chromium_indexeddb as idb

    db = idb.WrappedIndexDB(leveldb_dir)
    try:
        raw = db._raw_db
        out = []
        for db_no in range(1, 9):
            for store_no in range(1, 9):
                try:
                    for rec in raw.iterate_records(db_no, store_no):
                        v = rec.value
                        if isinstance(v, dict) and isinstance(v.get("medias"), list):
                            out.append(v)
                except Exception:  # noqa: BLE001  Database/store number does not exist.
                    continue
        return out
    finally:
        db.close()


def truth_events(media: dict) -> list[dict]:
    out = []
    for e in media.get("events") or []:
        t = e.get("time")
        if t is None:
            continue
        out.append({"t": round(float(t) / 1000.0, 3), "type": TYPE_MAP.get(e.get("type"), e.get("type")),
                    "name": e.get("name")})
    return sorted(out, key=lambda x: x["t"])


def build_truth(matches: list[dict], only: set[str] | None) -> tuple[dict[str, dict], list[str]]:
    """Return ({video path: truth}, warnings)."""
    truths: dict[str, dict] = {}
    warnings: list[str] = []
    for m in matches:
        for media in m.get("medias") or []:
            path = (media or {}).get("path")
            if not path or not os.path.exists(path):
                continue
            if only is not None and os.path.normcase(os.path.abspath(path)) not in only:
                continue
            events = truth_events(media)
            if not events:
                warnings.append(f"No event records (isServiceDown={m.get('isServiceDown')}): {path}")
                continue
            truths[path] = {"video": os.path.basename(path), "events": events}
    return truths, warnings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export Outplayed events as ground truth for accuracy evaluation")
    ap.add_argument("--out", required=True)
    ap.add_argument("--idb", default=os.path.expandvars(DEFAULT_IDB))
    ap.add_argument("--video", action="append", help="Export only these videos (may be repeated)")
    a = ap.parse_args(argv)
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    src = Path(a.idb)
    if not src.is_dir():
        print(f"Error: IndexedDB directory not found: {src}", file=sys.stderr)
        return EXIT_UNREADABLE
    only = {os.path.normcase(os.path.abspath(v)) for v in a.video} if a.video else None
    with tempfile.TemporaryDirectory(prefix="aditor_idb_") as tmp:
        copy = Path(tmp) / "idb"
        try:
            shutil.copytree(src, copy)
            matches = read_matches(copy)
        except ImportError:
            print("Error: ccl_chromium_reader is missing (pip install ccl_chromium_reader)", file=sys.stderr)
            return EXIT_UNREADABLE
        except Exception as e:  # noqa: BLE001
            print(f"Error: Could not parse IndexedDB: {e!r}; use manual annotation instead", file=sys.stderr)
            return EXIT_UNREADABLE
    if not matches:
        print("Error: No match records in IndexedDB; use manual annotation instead", file=sys.stderr)
        return EXIT_UNREADABLE
    truths, warnings = build_truth(matches, only)
    for w in warnings:
        print("Warning: " + w, file=sys.stderr)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for path, doc in truths.items():
        dest = out / (Path(path).stem + ".truth.json")
        dest.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{dest}: {len(doc['events'])} events")
    if not truths:
        print("Error: No existing videos have Outplayed event records; use manual annotation instead", file=sys.stderr)
        return EXIT_NO_TRUTH
    return 0


if __name__ == "__main__":
    sys.exit(main())
