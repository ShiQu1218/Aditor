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
    """容器起點（format start_time）。ffmpeg 解碼出的時間軸以容器起點為 0，事件時間因此以它為基準；
    關鍵影格必須用同一個基準（視訊串流比音訊晚開始時，兩者才不會差一個偏移）。"""
    doc = _run(["-show_entries", "format=start_time", path])
    try:
        return float((doc.get("format") or {}).get("start_time") or 0.0)
    except (TypeError, ValueError):
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
    """掃描封包（不解碼）取得關鍵影格時間，已扣除容器起點（與事件時間同一基準）。"""
    start = _start_time(path)
    try:
        r = subprocess.run([ffbin.ffprobe(), "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path],
                           capture_output=True, timeout=600)
    except FileNotFoundError as e:
        raise ProbeError(str(e)) from e
    except subprocess.TimeoutExpired as e:
        raise ProbeError("ffprobe 逾時") from e
    if r.returncode != 0:
        raise ProbeError(r.stderr.decode("utf-8", errors="replace")[-500:] or "ffprobe 失敗")
    out = []
    for line in r.stdout.decode("utf-8", errors="replace").splitlines():
        ts, _, flags = line.strip().partition(",")
        if "K" in flags and ts not in ("", "N/A"):
            try:
                out.append(round(float(ts) - start, 3))
            except ValueError:
                continue
    out.sort()
    return out
