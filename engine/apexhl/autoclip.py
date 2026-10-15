"""自動剪輯模組：依時間間隔分群、長度切割、重疊合併與中點平分（spec §5.4）。"""
from __future__ import annotations

from dataclasses import dataclass

from apexhl.derive import is_counted
from apexhl.models import AutoClipParams, Clip, Event


@dataclass
class _DraftClip:
    start: float
    end: float
    event_ids: list[str]


def auto_clips(events: list[Event], params: AutoClipParams, duration: float) -> list[Clip]:
    """依參數自計數事件清單自動產生剪輯片段。

    規則（spec §5.4）：
    1. 僅使用 is_counted 為 True 的事件，依時間排序。相鄰事件間隔 <= gap 歸為同一群。
    2. 群內事件數 >= n 才成立。
    3. 片段範圍為 [首殺 - before, 末殺 + after]，限制在影片範圍 [0, duration] 內。
    4. 若片段超過 max_len：在群內最大事件間隔處切成兩個子群，各自遞迴；子群若事件數 < n 則不成立。
       若群內事件時間完全相同無法切割，則輸出置中於群、長度為 max_len 且限制在影片範圍內的片段。
    5. 重疊片段處理：
       - 若合併後長度 <= max_len，則合併為一段（聯集 event_ids，依時間排序）。
       - 若合併後長度 > max_len，則將前段 end 與後段 start 設為重疊區中點 ((next.start + prev.end) / 2)。
       - 重複合併與邊界修正直到穩定。
    6. Clip.id = f"c{int(start*1000)}" 於最終邊界確定後計算；origin="ai"；依 start 排序。
    """
    counted_events = [e for e in events if is_counted(e)]
    if not counted_events:
        return []

    counted_events.sort(key=lambda e: e.t)
    event_map = {e.id: e for e in counted_events}

    # 1. 依 gap 分群
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

    # 2. 群內事件數 >= n 才成立
    valid_groups = [g for g in groups if len(g) >= params.n]
    if not valid_groups:
        return []

    # 3 & 4. 遞迴轉換群為候選片段（若超出 max_len 則在最大相鄰間隔處切開遞迴）
    def _split_group(grp: list[Event]) -> list[_DraftClip]:
        if len(grp) < params.n:
            return []

        start = max(0.0, grp[0].t - params.before)
        end = min(duration, grp[-1].t + params.after)

        if end <= start:
            return []

        if (end - start) <= params.max_len + 1e-9:
            return [_DraftClip(start=start, end=end, event_ids=[e.id for e in grp])]

        # 計算群內相鄰事件間隔
        gaps = [grp[i + 1].t - grp[i].t for i in range(len(grp) - 1)]
        if not gaps or max(gaps) <= 0.0:
            # 群內事件時間完全相同無法以相鄰間隔切割時，
            # 輸出置中於群、長度限制為 max_len 的片段（限制在影片範圍 [0, duration] 內）
            center = (grp[0].t + grp[-1].t) / 2.0
            c_start = max(0.0, center - params.max_len / 2.0)
            c_end = min(duration, c_start + params.max_len)
            if c_end - c_start < params.max_len and c_start > 0.0:
                c_start = max(0.0, c_end - params.max_len)
            return [_DraftClip(start=c_start, end=c_end, event_ids=[e.id for e in grp])]

        # 優先在能讓兩子群皆具備 >= n 個事件的候選點中尋找最大相鄰間隔（ties: 優先取最早者）
        valid_indices = [i for i in range(params.n - 1, len(grp) - params.n)]
        if valid_indices:
            best_i = max(valid_indices, key=lambda i: (grp[i + 1].t - grp[i].t))
        else:
            # 群事件數 < 2 * n 時無法兩邊皆 >= n，直接在所有相鄰間隔中取最大者（ties: 取最早者）；
            # 切割後事件數 < n 的子群遞迴時會自然回傳空清單（不產生片段）。
            best_i = max(range(len(grp) - 1), key=lambda i: (grp[i + 1].t - grp[i].t))

        left = grp[: best_i + 1]
        right = grp[best_i + 1 :]
        return _split_group(left) + _split_group(right)

    draft_clips: list[_DraftClip] = []
    for g in valid_groups:
        draft_clips.extend(_split_group(g))

    if not draft_clips:
        return []

    # 5. 重疊合併與中點平分（重複直到穩定）
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
                    # 合併片段並聯集事件清單（保持依事件時間排序）
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

    # 6. 排除無效片段、依 start 排序並建立正式 Clip 物件
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
