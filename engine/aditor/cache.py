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
        return v.parent / (v.name + ".aditor.json")
    key = hashlib.sha1(_normalize(video_path).encode("utf-8")).hexdigest()
    return Path(cache_dir) / (key + ".json")


def legacy_cache_path(video_path: str, cache_dir: Path, beside: bool = False) -> Path:
    """The pre-full-filename beside path, used only when its document names this video."""
    if not beside:
        return cache_path(video_path, cache_dir)
    v = Path(video_path)
    return v.parent / (v.stem + ".aditor.json")


def _belongs_to_video(doc: dict | None, video_path: str) -> bool:
    video = (doc or {}).get("video") if isinstance(doc, dict) else None
    stored = video.get("path") if isinstance(video, dict) else None
    return isinstance(stored, str) and _normalize(stored) == _normalize(video_path)


def load_cache(p: Path) -> dict | None:
    try:
        with open(p, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def resolve_cache_path(video_path: str, cache_dir: Path, beside: bool = False) -> Path:
    """Find the newest valid copy, preferring the configured location when timestamps tie."""
    preferred = cache_path(video_path, cache_dir, beside)
    legacy = legacy_cache_path(video_path, cache_dir, True)
    other = cache_path(video_path, cache_dir, not beside)
    candidates = ((preferred, False), (legacy, True), (other, False)) if beside else ((preferred, False), (other, False), (legacy, True))
    valid = []
    for index, (candidate, old_name) in enumerate(candidates):
        doc = load_cache(candidate) if candidate.is_file() else None
        if doc is not None and (not old_name or _belongs_to_video(doc, video_path)):
            valid.append((index, candidate, doc))
    if not valid:
        return preferred
    same_video = [item for item in valid if _belongs_to_video(item[2], video_path)]
    if not same_video:
        return valid[0][1]
    # shortcut: mtime orders copies; use explicit revisions if external sync must preserve conflicting edits.
    def mtime(item):
        try:
            return item[1].stat().st_mtime_ns
        except OSError:
            return -1
    return max(same_video, key=lambda item: (mtime(item), -item[0]))[1]


def prepare_cache(video_path: str, cache_dir: Path, beside: bool = False) -> tuple[Path, dict | None]:
    """Read the configured or compatible old cache and copy it to the new write path without deleting the source."""
    target = cache_path(video_path, cache_dir, beside)
    source = resolve_cache_path(video_path, cache_dir, beside)
    old = load_cache(source)
    if old is not None and source != target:
        migrated = {**old, "cache_path": str(target)}
        try:
            written = save_cache(target, migrated, fallback_dir=cache_dir)
        except OSError:
            written = target
        else:
            target = written
            migrated["cache_path"] = str(written)
            old = migrated
    return target, old


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
    video_path = (doc.get("video") or {}).get("path") if isinstance(doc, dict) else None
    fb = cache_path(video_path, Path(fallback_dir)) if isinstance(video_path, str) else Path(fallback_dir) / p.name
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
    if t in ("assist_knock", "assist_elim"):
        return "assist"
    return "highlight" if t in ("multikill", "ace") else t  # A Valorant multikill becomes an ace when a kill is added.


def merge_reanalysis(old_events: list[Event], new_auto: list[Event]) -> tuple[list[Event], list[Event]]:
    manual = [e for e in old_events if e.source == "manual"]
    new = list(new_auto)
    received: set[int] = set()
    unmatched: list[Event] = []
    olds = sorted((e for e in old_events if e.source != "manual" and _has_state(e)),
                  key=lambda e: e.t)
    pending = []
    for o in olds:
        match = next((i for i, n in enumerate(new) if i not in received and n.id == o.id), None)
        if match is None:
            pending.append(o)
            continue
        received.add(match)
        new[match] = replace(new[match], deleted=o.deleted, counted_override=o.counted_override)
    olds = pending
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
