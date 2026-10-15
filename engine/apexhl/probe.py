from __future__ import annotations

import json
import os
import subprocess

from . import ffbin
from .models import VideoInfo


class ProbeError(Exception):
    pass


def is_16x9(w: int, h: int) -> bool:
    if h <= 0:
        return False
    return abs(w / h - 16 / 9) / (16 / 9) <= 0.01


def _run(args: list[str]) -> dict:
    try:
        r = subprocess.run([ffbin.ffprobe(), "-v", "error", "-of", "json", *args],
                           capture_output=True, timeout=120)
    except FileNotFoundError as e:
        raise ProbeError(str(e)) from e
    except subprocess.TimeoutExpired as e:
        raise ProbeError("ffprobe 逾時") from e
    if r.returncode != 0:
        raise ProbeError(r.stderr.decode("utf-8", errors="replace")[-500:] or "ffprobe 失敗")
    try:
        return json.loads(r.stdout.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise ProbeError("ffprobe 輸出無法解析") from e


def _start_time(path: str) -> float:
    doc = _run(["-select_streams", "v:0", "-show_entries", "stream=start_time", path])
    try:
        return float(doc["streams"][0].get("start_time") or 0.0)
    except (KeyError, IndexError, ValueError):
        return 0.0


def probe(path: str) -> VideoInfo:
    doc = _run(["-select_streams", "v:0", "-show_entries",
                "stream=codec_name,width,height,start_time:format=duration,start_time", path])
    streams = doc.get("streams") or []
    if not streams:
        raise ProbeError("找不到影像串流")
    s = streams[0]
    fmt = doc.get("format", {})
    try:
        start = float(s.get("start_time") or fmt.get("start_time") or 0.0)
        duration = float(fmt.get("duration"))
        st = os.stat(path)
        return VideoInfo(path=path, duration=duration, width=int(s["width"]), height=int(s["height"]),
                         codec=s.get("codec_name", ""), start_time=start,
                         size=st.st_size, mtime=st.st_mtime)
    except (TypeError, ValueError, KeyError) as e:
        raise ProbeError(f"ffprobe 欄位缺漏：{e!r}") from e


def keyframes(path: str) -> list[float]:
    start = _start_time(path)
    doc = _run(["-skip_frame", "nokey", "-select_streams", "v:0",
                "-show_entries", "frame=pts_time", path])
    out = []
    for f in doc.get("frames", []):
        v = f.get("pts_time")
        if v not in (None, "N/A"):
            out.append(round(float(v) - start, 3))
    out.sort()
    return out
