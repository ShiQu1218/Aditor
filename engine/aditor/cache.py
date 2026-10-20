"""Cache persistence and merge behavior for reanalysis (spec §4.2)."""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import replace
from pathlib import Path

from . import ENGINE_VERSION
from .models import Clip, Event, VideoInfo

MATCH_WINDOW = 1.0


def _normalize(path: str) -> str:
    return os.path.abspath(path).lower().replace("\\", "/")


def cache_path(video_path: str, cache_dir: Path, beside: bool = False) -> Path:
    if beside:
        v = Path(video_path)
        return v.parent / (v.stem + ".aditor.json")
    key = hashlib.sha1(_normalize(video_path).encode("utf-8")).hexdigest()
    return Path(cache_dir) / (key + ".json")


def load_cache(p: Path) -> dict | None:
    try:
        with open(p, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _write(p: Path, doc: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    os.replace(tmp, p)


def save_cache(p: Path, doc: dict, fallback_dir: Path | None = None) -> Path:
    p = Path(p)
    try:
        _write(p, doc)
        return p
    except OSError:
        if fallback_dir is None:
            raise
    fb = Path(fallback_dir) / p.name
    _write(fb, doc)
    return fb


def needs_reanalysis(doc: dict | None, info: VideoInfo, templates_version: str,
                     aspect_squash: float | None = 1.0, game: str = "apex") -> bool:
    """Whether a cache needs reanalysis: it is incomplete, the video changed, the engine/template version differs (invalidating caches from the old text-keyword method), or it was analyzed for another game aspect (caches without the field are 16:9; None accepts any aspect, for untagged videos whose aspect is detected)."""
    if not doc:
        return True
    analysis = doc.get("analysis") or {}
    video = doc.get("video") or {}
    if analysis.get("status") != "done":
        return True
    if video.get("size") != info.size:
        return True
    if abs(float(video.get("mtime", -1.0)) - info.mtime) >= 1e-6:
        return True
    if analysis.get("engine_version") != ENGINE_VERSION:
        return True
    if aspect_squash is not None and analysis.get("aspect_squash", 1.0) != aspect_squash:
        return True
    if doc.get("game", "apex") != game:  # Caches without the field are Apex.
        return True
    return analysis.get("templates_version") != templates_version


def _has_state(e: Event) -> bool:
    return e.deleted or e.counted_override is not None


def _family(t: str) -> str:
    """Event type families used for matching: assist_knock and assist_elim are interchangeable because engine updates may reclassify assist subtypes, and must not discard user state."""
    return "assist" if t in ("assist_knock", "assist_elim") else t


def merge_reanalysis(old_events: list[Event], new_auto: list[Event]) -> tuple[list[Event], list[Event]]:
    manual = [e for e in old_events if e.source == "manual"]
    new = list(new_auto)
    received: set[int] = set()
    unmatched: list[Event] = []
    olds = sorted((e for e in old_events if e.source != "manual" and _has_state(e)),
                  key=lambda e: e.t)
    for o in olds:
        best, best_d = None, None
        for i, n in enumerate(new):
            if i in received or _family(n.type) != _family(o.type):
                continue
            d = abs(n.t - o.t)
            if d <= MATCH_WINDOW and (best_d is None or d < best_d):
                best, best_d = i, d
        if best is None:
            unmatched.append(o)
            continue
        received.add(best)
        new[best] = replace(new[best], deleted=o.deleted, counted_override=o.counted_override)
    merged = sorted(manual + new, key=lambda e: e.t)
    return merged, unmatched


def merge_clips(old_clips: list[Clip], new_ai: list[Clip]) -> list[Clip]:
    keep = [c for c in old_clips if c.origin == "manual"]
    return sorted(keep + list(new_ai), key=lambda c: c.start)
