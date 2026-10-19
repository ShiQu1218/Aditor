"""Automatic clip generation: group by time gap, split by length, merge overlaps, and divide at the midpoint (spec §5.4)."""
from __future__ import annotations

from dataclasses import dataclass

from aditor.derive import is_counted
from aditor.models import AutoClipParams, Clip, Event


@dataclass
class _DraftClip:
    start: float
    end: float
    event_ids: list[str]


def auto_clips(events: list[Event], params: AutoClipParams, duration: float) -> list[Clip]:
    """Generate clips automatically from counted events and the supplied parameters.

    Rules (spec §5.4):
    1. Use only events where is_counted is True, sorted by time. Adjacent events belong to the same group when their gap <= gap.
    2. A group is valid only if it contains at least n events.
    3. Clip range is [first kill - before, last kill + after], clamped to [0, duration].
    4. If a clip exceeds max_len, split the group at its largest event gap and repeat; discard subgroups with fewer than n events.
       If all event times are identical and cannot be split, center a max_len clip on the group and clamp it to the video range.
    5. Handle overlapping clips:
       - If the merged length is <= max_len, merge them (union event_ids, sorted by time).
       - If the merged length is > max_len, set the previous end and next start to the overlap midpoint ((next.start + prev.end) / 2).
       - Repeat merging and boundary adjustment until stable.
    6. Set Clip.id = f"c{int(start*1000)}" after finalizing boundaries; set origin="ai"; sort by start.
    """
    counted_events = [e for e in events if is_counted(e)]
    if not counted_events:
        return []

    counted_events.sort(key=lambda e: e.t)
    event_map = {e.id: e for e in counted_events}

    # 1. Group by gap.
    groups: list[list[Event]] = []
    current_group: list[Event] = []
    for e in counted_events:
        if not current_group:
            current_group.append(e)
        elif e.t - current_group[-1].t <= params.gap:
            current_group.append(e)
        else:
            groups.append(current_group)
            current_group = [e]
    if current_group:
        groups.append(current_group)

    # 2. Keep groups with at least n events.
    valid_groups = [g for g in groups if len(g) >= params.n]
    if not valid_groups:
        return []

    # 3 & 4. Split index ranges to avoid deep recursion and repeated subgroup copies; push the right side first to preserve left-to-right output.
    def _split_group(grp: list[Event]) -> list[_DraftClip]:
        clips: list[_DraftClip] = []
        pending = [(0, len(grp))]
        while pending:
            lo, hi = pending.pop()
            if hi - lo < params.n:
                continue

            start = max(0.0, grp[lo].t - params.before)
            end = min(duration, grp[hi - 1].t + params.after)
            if end <= start:
                continue

            if (end - start) <= params.max_len + 1e-9:
                clips.append(_DraftClip(start, end, [grp[i].id for i in range(lo, hi)]))
                continue

            if grp[hi - 1].t == grp[lo].t:
                # Events at the same time cannot be split; center the clip and clamp it to the video range.
                center = (grp[lo].t + grp[hi - 1].t) / 2.0
                c_start = max(0.0, center - params.max_len / 2.0)
                c_end = min(duration, c_start + params.max_len)
                if c_end - c_start < params.max_len and c_start > 0.0:
                    c_start = max(0.0, c_end - params.max_len)
                clips.append(_DraftClip(c_start, c_end, [grp[i].id for i in range(lo, hi)]))
                continue

            # Prefer a split where both sides have >= n events; otherwise allow undersized subgroups to be discarded. Break gap ties at the earliest point.
            candidates = range(lo + params.n - 1, hi - params.n)
            if not candidates:
                candidates = range(lo, hi - 1)
            best_i = max(candidates, key=lambda i: grp[i + 1].t - grp[i].t)
            pending.append((best_i + 1, hi))
            pending.append((lo, best_i + 1))
        return clips

    draft_clips: list[_DraftClip] = []
    for g in valid_groups:
        draft_clips.extend(_split_group(g))

    if not draft_clips:
        return []

    # 5. Merge overlaps and split at the midpoint (repeat until stable).
    while True:
        draft_clips.sort(key=lambda c: (c.start, c.end))
        changed = False
        i = 0
        while i < len(draft_clips) - 1:
            prev = draft_clips[i]
            nxt = draft_clips[i + 1]

            if nxt.start < prev.end:
                merged_start = min(prev.start, nxt.start)
                merged_end = max(prev.end, nxt.end)
                if (merged_end - merged_start) <= params.max_len + 1e-9:
                    # Merge clips and union event IDs, keeping them sorted by event time.
                    merged_ids = list(dict.fromkeys(prev.event_ids + nxt.event_ids))
                    merged_ids.sort(key=lambda eid: event_map[eid].t)
                    draft_clips[i] = _DraftClip(
                        start=merged_start,
                        end=merged_end,
                        event_ids=merged_ids,
                    )
                    draft_clips.pop(i + 1)
                    changed = True
                    continue
                else:
                    mid = (nxt.start + prev.end) / 2.0
                    if abs(prev.end - mid) > 1e-9 or abs(nxt.start - mid) > 1e-9:
                        prev.end = mid
                        nxt.start = mid
                        changed = True
            i += 1

        if not changed:
            break

    # 6. Drop invalid clips, sort by start, and create Clip objects.
    valid_clips = [c for c in draft_clips if c.end > c.start]
    valid_clips.sort(key=lambda c: (c.start, c.end))

    return [
        Clip(
            id=f"c{int(round(c.start * 1000))}",
            start=c.start,
            end=c.end,
            origin="ai",
            event_ids=c.event_ids,
        )
        for c in valid_clips
    ]
