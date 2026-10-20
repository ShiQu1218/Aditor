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
        raise ProbeError("ffprobe timed out") from e
    if r.returncode != 0:
        raise ProbeError(r.stderr.decode("utf-8", errors="replace")[-500:] or "ffprobe failed")
    try:
        return json.loads(r.stdout.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise ProbeError("Could not parse ffprobe output") from e


def _start_time(path: str) -> float:
    """Container start time (format start_time). FFmpeg's decoded timeline starts at zero relative to the container,
    so event timestamps use this as their reference. Keyframes must use the same reference to avoid an offset
    when the video stream starts later than the audio stream."""
    doc = _run(["-show_entries", "format=start_time", path])
    try:
        return float((doc.get("format") or {}).get("start_time") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _rate(value: object) -> float:
    """Parse an ffprobe "num/den" rate; return 0 for missing, zero, or malformed values."""
    if not isinstance(value, str):
        return 0.0
    num, _, den = value.partition("/")
    try:
        n, d = float(num), float(den or 1)
    except ValueError:
        return 0.0
    return n / d if n > 0 and d > 0 else 0.0


def _frame_rate(stream: dict) -> float:
    """Average frame rate (actual for VFR captures), falling back to the nominal r_frame_rate; 0 when unknown."""
    return _rate(stream.get("avg_frame_rate")) or _rate(stream.get("r_frame_rate"))


def probe(path: str) -> VideoInfo:
    doc = _run(["-select_streams", "v:0", "-show_entries",
                "stream=codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,start_time:format=duration,start_time",
                path])
    streams = doc.get("streams") or []
    if not streams:
        raise ProbeError("No video stream found")
    s = streams[0]
    fmt = doc.get("format", {})
    try:
        start = float(s.get("start_time") or fmt.get("start_time") or 0.0)
        duration = float(fmt.get("duration"))
        st = os.stat(path)
        return VideoInfo(path=path, duration=duration, width=int(s["width"]), height=int(s["height"]),
                         codec=s.get("codec_name", ""), start_time=start,
                         size=st.st_size, mtime=st.st_mtime,
                         fps=_frame_rate(s), pix_fmt=s.get("pix_fmt") or "")
    except (TypeError, ValueError, KeyError) as e:
        raise ProbeError(f"Missing ffprobe field: {e!r}") from e


def keyframes(path: str) -> list[float]:
    """Scan packets without decoding to get keyframe times, subtracting the container start to match the event-time basis."""
    start = _start_time(path)
    try:
        r = subprocess.run([ffbin.ffprobe(), "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path],
                           capture_output=True, timeout=600)
    except FileNotFoundError as e:
        raise ProbeError(str(e)) from e
    except subprocess.TimeoutExpired as e:
        raise ProbeError("ffprobe timed out") from e
    if r.returncode != 0:
        raise ProbeError(r.stderr.decode("utf-8", errors="replace")[-500:] or "ffprobe failed")
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
