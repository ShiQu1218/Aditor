"""計數推導：依規則設定事件的 counted 與 counted_reason，並進行同敵人去重（spec §5.3）。"""
from __future__ import annotations

from dataclasses import replace

from apexhl.detect import same_name
from apexhl.models import COUNTING_TYPES, Event, NameSig, SpecInterval
from apexhl.profile import Profile


def sig_similar(a: str | None, b: str | None, threshold: float) -> bool:
    """比對兩個 base64 名字指紋是否屬於同一敵人。

    任一為 None → False；其餘解碼後委託 detect.same_name（含寬度比差 ≥ 15% 門檻與相關係數）。
    """
    if not a or not b:
        return False
    try:
        sig_a = NameSig.from_b64(a)
        sig_b = NameSig.from_b64(b)
    except Exception:
        return False
    return same_name(sig_a, sig_b, threshold)


def is_counted(e: Event) -> bool:
    """判斷事件最終是否計入。

    若 deleted 為 True 則一律 False；否則優先採用 counted_override，未設定時採用 counted。
    """
    if e.deleted:
        return False
    return e.counted_override if e.counted_override is not None else e.counted


def derive(
    events: list[Event],
    spectating: list[SpecInterval],
    profile: Profile,
) -> list[Event]:
    """推導整份事件清單的 counted 與 counted_reason。

    回傳新 Event 物件清單（依 t 排序）。不修改 counted_override。
    規則（spec §5.3）：
    1. deleted 事件：counted=False, counted_reason="deleted"，不參與去重。
    2. 非計數類型（如 squad_wipe）：counted=False, counted_reason="not_counting_type"，不作為去重首筆。
    3. 位於 spectating 區間內（start <= t < end）：counted=False, counted_reason="spectating"。
    4. 去重：dedupe_window 秒內名字指紋相似的計數類型事件，第一筆 counted=True（first），其餘 counted=False（duplicate）。
       若 name_sig 為 None（如手動事件），則為 first 且不與任何人去重。
    """
    sorted_events = sorted(events, key=lambda ev: ev.t)
    result: list[Event] = []
    first_events: list[Event] = []

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
            is_dup = False
            if e.name_sig is not None:
                for f in first_events:
                    if 0 <= e.t - f.t <= profile.dedupe_window and sig_similar(
                        f.name_sig, e.name_sig, profile.name_sig_threshold
                    ):
                        is_dup = True
                        break

            if is_dup:
                counted = False
                counted_reason = "duplicate"
            else:
                counted = True
                counted_reason = "first"
                if e.name_sig is not None:
                    first_events.append(e)

        new_event = replace(e, counted=counted, counted_reason=counted_reason)
        result.append(new_event)

    return result
