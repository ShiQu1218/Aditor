"""從 Outplayed 的 IndexedDB 匯出正確答案（spec §8）。

用法：python tools/outplayed_truth.py --out truth_dir [--idb <leveldb 資料夾>] [--video <影片路徑> ...]

- 先把整個 leveldb 資料夾複製到暫存目錄再讀（避免鎖檔與誤改原資料）。
- 以 ccl_chromium_reader 讀取 match 記錄（內含 medias[].events）；對「檔案仍存在且有事件」的每支影片輸出
  `<影片檔名>.truth.json`：{"video": 檔名, "events": [{"t": 秒, "type": "knock"|"assist"|"kill"|...}]}。
- 事件 time 為毫秒、相對該 media（影片）開頭，直接除以 1000 即為「從影片開頭起算的秒數」
  （Outplayed 匯出片的 media.startTime 為 0；與畫面橫幅之間的固定偏移由 evaluate 以中位數估計）。
- 沒有事件的影片（例如 Overwolf 事件服務中斷時錄的長片，記錄為 isServiceDown）不輸出，避免空真值造成誤判。
- 無法解析時印出原因並以非 0 結束。
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
    """回傳所有 match 記錄（含 medias 的 dict）。"""
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
                except Exception:  # noqa: BLE001  不存在的 db／store 編號
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
    """回傳 ({影片路徑: truth}, 警告)。"""
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
                warnings.append(f"沒有事件記錄（isServiceDown={m.get('isServiceDown')}）：{path}")
                continue
            truths[path] = {"video": os.path.basename(path), "events": events}
    return truths, warnings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="匯出 Outplayed 事件作為準確率評估的真值")
    ap.add_argument("--out", required=True)
    ap.add_argument("--idb", default=os.path.expandvars(DEFAULT_IDB))
    ap.add_argument("--video", action="append", help="只匯出這些影片（可重複）")
    a = ap.parse_args(argv)
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    src = Path(a.idb)
    if not src.is_dir():
        print(f"錯誤：找不到 IndexedDB 資料夾：{src}", file=sys.stderr)
        return EXIT_UNREADABLE
    only = {os.path.normcase(os.path.abspath(v)) for v in a.video} if a.video else None
    with tempfile.TemporaryDirectory(prefix="aditor_idb_") as tmp:
        copy = Path(tmp) / "idb"
        try:
            shutil.copytree(src, copy)
            matches = read_matches(copy)
        except ImportError:
            print("錯誤：缺少 ccl_chromium_reader（pip install ccl_chromium_reader）", file=sys.stderr)
            return EXIT_UNREADABLE
        except Exception as e:  # noqa: BLE001
            print(f"錯誤：無法解析 IndexedDB：{e!r}；請改以人工標註", file=sys.stderr)
            return EXIT_UNREADABLE
    if not matches:
        print("錯誤：IndexedDB 內沒有 match 記錄；請改以人工標註", file=sys.stderr)
        return EXIT_UNREADABLE
    truths, warnings = build_truth(matches, only)
    for w in warnings:
        print("警告：" + w, file=sys.stderr)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for path, doc in truths.items():
        dest = out / (Path(path).stem + ".truth.json")
        dest.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{dest}：{len(doc['events'])} 個事件")
    if not truths:
        print("錯誤：沒有任何現存影片帶有 Outplayed 事件記錄；請改以人工標註", file=sys.stderr)
        return EXIT_NO_TRUTH
    return 0


if __name__ == "__main__":
    sys.exit(main())
