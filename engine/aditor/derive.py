"""Derive counted and counted_reason fields from events and deduplicate events for the same enemy (spec §5.3)."""
from __future__ import annotations

from collections import deque
from dataclasses import replace
from functools import lru_cache

from aditor.detect import same_name
from aditor.models import COUNTING_TYPES, Event, NameSig, SpecInterval
from aditor.profile import Profile


def _decode_sig(value: str | None) -> NameSig | None:
    if not value:
        return None
    try:
        return NameSig.from_b64(value)
    except Exception:
        return None


def sig_similar(a: str | None, b: str | None, threshold: float) -> bool:
    """Compare two base64 name signatures to determine whether they belong to the same enemy.

    Either value being None returns False; otherwise decode both and delegate to detect.same_name
    (including its >= 15% width-ratio difference threshold and correlation check).
    """
    return same_name(_decode_sig(a), _decode_sig(b), threshold)


def is_counted(e: Event) -> bool:
    """Determine whether an event is counted.

    Always return False when deleted is True; otherwise prefer counted_override and fall back to counted when unset.
    """
    if e.deleted:
        return False
    return e.counted_override if e.counted_override is not None else e.counted


def derive(
    events: list[Event],
    spectating: list[SpecInterval],
    profile: Profile,
) -> list[Event]:
    """Derive counted and counted_reason for an entire event list.

    Return a new list of Event objects sorted by t. Do not modify counted_override.
    Rules (spec §5.3):
    1. Deleted events: counted=False, counted_reason="deleted"; exclude them from deduplication.
    2. Non-counting types (such as squad_wipe; no longer emitted by the engine but retained for old project files):
       counted=False, counted_reason="not_counting_type"; do not use them as the first event in a deduplication group.
    3. Events inside a spectating interval (start <= t < end): counted=False, counted_reason="spectating".
    4. Deduplicate countable events with similar name fingerprints within dedupe_window seconds. The first event is
       counted=True (first); the rest are counted=False (duplicate). If name_sig is None (for example, for a manual
       event), treat it as first and do not deduplicate it against any other event.
    """
    sorted_events = sorted(events, key=lambda ev: ev.t)
    result: list[Event] = []
    first_events: deque[tuple[float, NameSig]] = deque()
    # Keep this cache local to the current derivation and bound its size to avoid retaining every fingerprint for long videos.
    decode_sig = lru_cache(maxsize=256)(_decode_sig)

    for e in sorted_events:
        if e.deleted:
            counted = False
            counted_reason = "deleted"
        elif e.type not in COUNTING_TYPES:
            counted = False
            counted_reason = "not_counting_type"
        elif any(s.start <= e.t < s.end for s in spectating):
            counted = False
            counted_reason = "spectating"
        else:
            while first_events and e.t - first_events[0][0] > profile.dedupe_window:
                first_events.popleft()
            sig = decode_sig(e.name_sig) if isinstance(e.name_sig, str) else None
            is_dup = sig is not None and any(
                0 <= e.t - t <= profile.dedupe_window and same_name(first_sig, sig, profile.name_sig_threshold)
                for t, first_sig in first_events
            )

            if is_dup:
                counted = False
                counted_reason = "duplicate"
            else:
                counted = True
                counted_reason = "first"
                if sig is not None:
                    first_events.append((e.t, sig))

        new_event = replace(e, counted=counted, counted_reason=counted_reason)
        result.append(new_event)

    return result
