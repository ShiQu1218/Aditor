import numpy as np

from apexhl.events import EventTracker
from apexhl.models import FrameResult, NameSig
from apexhl.profile import load_profile
from pathlib import Path

PROFILE = load_profile(Path(__file__).resolve().parents[2] / "templates" / "zh-TW")

KINDS = {"K": "knock", "A": "assist_knock", "E": "elim"}


def sig(seed: int, width: int = 60) -> NameSig:
    rng = np.random.default_rng(seed)
    return NameSig(width, (rng.random((16, width)) > 0.5).astype(np.uint8))


def fr(kind=None, name=None, spec=False, score=0.9, damage=False, alt=None):
    return FrameResult(kind=kind, score=score, x=0, damage_line=damage, name_sig=name, spectating=spec,
                       alt_sig=alt)


def seq(pattern, kind="knock", name=None, t0=0.0):
    """每個字元一格 (0.25s)：'.' 無命中，其他字元命中。空白略過。"""
    out = []
    i = 0
    for ch in pattern.replace(" ", ""):
        out.append((t0 + i * 0.25, fr(kind if ch != "." else None, name if ch != "." else None)))
        i += 1
    return out


def run(frames, **kw):
    tr = EventTracker(PROFILE, **kw)
    for t, r in frames:
        tr.feed(t, r)
    return tr.finish()


def test_two_frame_minimum():
    ev, _ = run(seq("..K..."))
    assert ev == []


def test_event_time_is_first_hit():
    ev, _ = run(seq("..KKKK"))
    assert len(ev) == 1 and ev[0].t == 0.5
    assert ev[0].id == "a500" and ev[0].type == "knock" and ev[0].source == "auto"


def test_gap_creates_new_event():
    ev, _ = run(seq("KKK..KKK"))
    assert [e.t for e in ev] == [0.0, 1.25]


def test_short_flicker_same_event():
    ev, _ = run(seq("KKK.KKK"))
    assert len(ev) == 1


def test_name_change_new_event():
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a) + seq("KKK", name=b, t0=0.75)
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].t == 0.75
    assert ev[0].name_sig == a.to_b64()


def test_same_name_one_event_and_missing_sig_does_not_split():
    a = sig(1)
    frames = seq("KK", name=a) + seq("KK", name=None, t0=0.5)
    ev, _ = run(frames)
    assert len(ev) == 1


def test_kind_change_new_event():
    frames = seq("AAA", kind="assist_knock") + seq("KKK", kind="knock", t0=0.75)
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["assist_knock", "knock"]


def test_resume_continuation_skipped():
    frames = seq("KKKK..KKK", t0=10.0)
    ev, _ = run(frames, resume_start=10.0)
    assert [e.t for e in ev] == [11.5]


def test_resume_not_hit_at_start_is_normal():
    ev, _ = run(seq(".KKK", t0=10.0), resume_start=10.0)
    assert [e.t for e in ev] == [10.25]


def test_score_max_and_damage_any():
    frames = [(0.0, fr("knock", score=0.7)), (0.25, fr("knock", score=0.95, damage=True)),
              (0.5, fr("knock", score=0.8))]
    ev, _ = run(frames)
    assert ev[0].score == 0.95 and ev[0].damage_line is True


def test_spectating_interval():
    frames = [(10 + i * 0.25, fr(spec=True)) for i in range(9)]
    _, sp = run(frames)
    assert len(sp) == 1 and sp[0].start == 10.0 and sp[0].end == 12.25
    frames = [(i * 0.25, fr(spec=True)) for i in range(7)]
    _, sp = run(frames)
    assert sp == []


def test_spectating_split_by_gap():
    frames = [(i * 0.25, fr(spec=(i != 9))) for i in range(20)]
    _, sp = run(frames)
    assert [(s.start, s.end) for s in sp] == [(0.0, 2.25), (2.5, 5.0)]


def test_aggregates_cover_frames_before_establishment():
    a = sig(1)
    frames = [(0.0, fr("knock", name=a, score=0.95, damage=True)),
              (0.25, fr("knock", score=0.7)), (0.5, fr("knock", score=0.6))]
    ev, _ = run(frames)
    assert len(ev) == 1
    assert ev[0].score == 0.95 and ev[0].damage_line is True
    assert ev[0].name_sig == a.to_b64()


def test_isolated_onset_frame_sets_t():
    ev, _ = run(seq("K.KK"))
    assert [e.t for e in ev] == [0.0]


def test_no_consecutive_pair_no_event():
    ev, _ = run(seq("K.K.K"))
    assert ev == []


def test_pair_then_gap_t_unchanged():
    ev, _ = run(seq("KK.K"))
    assert [e.t for e in ev] == [0.0]


def test_kind_change_lone_first_frame_not_established():
    frames = seq("KKK", kind="knock") + seq("E", kind="elim", t0=0.75) + seq("..", t0=1.0)
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["knock"]


def test_resume_continuation_with_one_frame_gap():
    ev, _ = run(seq("K.KK", t0=10.0), resume_start=10.0)
    assert ev == []


def test_single_frame_name_jitter_does_not_split():
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a) + seq("K", name=b, t0=0.75) + seq("KKK", name=a, t0=1.0)
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0


def test_two_consecutive_frames_of_new_name_split_from_first_different_frame():
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a) + seq("KK", name=b, t0=0.75)
    ev, _ = run(frames)
    assert [e.t for e in ev] == [0.0, 0.75]
    assert ev[1].name_sig == b.to_b64()


def test_alternating_names_never_split():
    a, b = sig(1), sig(2)
    frames = []
    for i in range(8):
        frames.append((i * 0.25, fr("knock", a if i % 2 == 0 else b)))
    ev, _ = run(frames)
    assert len(ev) == 1


def test_unstable_name_then_stable_name_is_one_event_with_stable_sig():
    # 前 4 格每格指紋皆不同（抖動），之後穩定：應為單一事件，起點為第一格，簽名採穩定名字
    jit = [sig(10 + i) for i in range(4)]
    stable = sig(99)
    frames = [(i * 0.25, fr("assist_elim", jit[i])) for i in range(4)]
    frames += [(1.0 + i * 0.25, fr("assist_elim", stable)) for i in range(3)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    assert ev[0].name_sig == stable.to_b64()


# --- Fix-ML-2：名字指紋逐格抖動（medoid／多數代表簽名） ---

def crop(base: NameSig, x0: int, w: int) -> NameSig:
    """同一個名字的一段（被 HUD 遮擋或淡出後剩下的殘片）。"""
    return NameSig(w, base.bits[:, x0:x0 + w].copy())


def noisy(base: NameSig, seed: int, flips: int = 6) -> NameSig:
    """同一個名字的輕微變體（翻幾個位元）：仍應判為同一人。"""
    rng = np.random.default_rng(1000 + seed)
    bits = base.bits.copy()
    idx = rng.choice(bits.size, flips, replace=False)
    bits.reshape(-1)[idx] ^= 1
    return NameSig(base.width, bits)


def test_every_frame_distinct_sig_is_still_one_event():
    # 連續 5 格命中、每格指紋彼此都不同（畫格層抖動）：不得整段被丟棄
    frames = [(i * 0.25, fr("knock", sig(200 + i))) for i in range(5)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0 and ev[0].type == "knock"


def test_jitter_run_uses_representative_sig_not_first_frame():
    from apexhl.detect import same_name
    good = sig(7)
    # 第 1 格是淡入的破碎指紋，之後多數格是同一個名字的變體，中間夾兩格不相干的抖動
    names = [sig(300), noisy(good, 1), sig(301), noisy(good, 2), noisy(good, 3), sig(302), noisy(good, 4)]
    frames = [(i * 0.25, fr("elim", n)) for i, n in enumerate(names)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    got = NameSig.from_b64(ev[0].name_sig)
    assert same_name(got, good, PROFILE.name_sig_threshold)


def test_jitter_between_two_enemies_still_splits_once():
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a)
    frames += [(0.75, fr("knock", sig(400))), (1.0, fr("knock", sig(401)))]  # 兩格各自不同的抖動
    frames += seq("KKK", name=b, t0=1.25)
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[0].t == 0.0 and ev[1].t == 1.25
    assert ev[1].name_sig == b.to_b64()


def test_lone_frame_before_split_does_not_leave_phantom_event():
    # 只有 1 格舊名字、之後是穩定的新名字 → 單一事件（舊名字格不獨立成事件）
    a, b = sig(1), sig(2)
    frames = seq("K", name=a) + seq("KKKK", name=b, t0=0.25)
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].name_sig == b.to_b64()


def test_jitter_does_not_lower_minimum_frames():
    # 兩格不連續（中間 1 格空白）、各自不同指紋：仍不成事件
    frames = [(0.0, fr("knock", sig(500))), (0.5, fr("knock", sig(501)))]
    ev, _ = run(frames)
    assert ev == []
    ev, _ = run([(0.0, fr("knock", sig(500)))])
    assert ev == []


# --- Fix-ML-2：跨類型（knock → elim）同敵人連結 ---

def _runs(*parts):
    """parts: (t0, kind, [名字指紋...])，每個指紋一格 (0.25s)。"""
    frames = []
    for t0, kind, names in parts:
        frames += [(t0 + i * 0.25, fr(kind, n)) for i, n in enumerate(names)]
    return frames


def test_elim_links_to_recent_knock_when_stable_frames_match():
    # knock 的指紋乾淨；elim 的畫格大多是破碎殘片，但有兩格取到完整名字（互相印證）
    a = sig(7)
    frames = _runs((0.0, "knock", [a, noisy(a, 1), a, noisy(a, 2)]),
                   (4.0, "elim", [sig(600), sig(601), noisy(a, 3), sig(602), noisy(a, 4), sig(603)]))
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["knock", "elim"]
    assert ev[1].name_sig == ev[0].name_sig  # 沿用同一敵人的指紋 → derive 會去重


def test_single_matching_frame_does_not_link():
    # 單格偶然相符（殘片）不足以連結：實測會把不同敵人連在一起
    a = sig(7)
    # （放在 PAIR_WINDOW 之外，只測指紋層）
    frames = _runs((0.0, "knock", [a, noisy(a, 1), a, noisy(a, 2)]),
                   (15.0, "elim", [sig(600), sig(601), noisy(a, 3), sig(602), sig(603)]))
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].name_sig != ev[0].name_sig


def test_elim_not_linked_when_no_frame_matches():
    a = sig(7)
    frames = _runs((0.0, "knock", [a, a, a]), (15.0, "elim", [sig(600), sig(601), sig(602)]))
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].name_sig != ev[0].name_sig


def test_link_window():
    a = sig(7)
    frames = _runs((0.0, "knock", [a, a, a]), (60.0, "elim", [a, a, a]))
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].name_sig == ev[0].name_sig == a.to_b64()  # 本來就同簽名：與連結無關
    far = _runs((0.0, "knock", [a, a, a]), (60.0, "elim", [sig(700), noisy(a, 5), noisy(a, 6)]))
    ev, _ = run(far)
    assert ev[1].name_sig != ev[0].name_sig  # 超過連結視窗不連結


def test_link_ignores_tiny_fragments():
    # 寬度過小的殘片相關性不可靠，不得用來連結
    small = NameSig(10, (np.random.default_rng(3).random((16, 10)) > 0.5).astype(np.uint8))
    frames = _runs((0.0, "knock", [small, small, small]), (4.0, "elim", [small, small, small]))
    ev, _ = run(frames)
    assert len(ev) == 2
    assert ev[1].name_sig == small.to_b64()  # 自己的指紋，未被替換（連結被拒絕時保持原樣）


def test_link_does_not_touch_squad_wipe_or_unrelated_names():
    a, b = sig(7), sig(8)
    frames = _runs((0.0, "knock", [a, a, a]), (4.0, "knock", [b, b, b]))
    ev, _ = run(frames)
    assert ev[0].name_sig == a.to_b64() and ev[1].name_sig == b.to_b64()


# --- Fix-ML-2：補刀（elim）依時間配對最近的擊倒 ---

def test_elim_pairs_with_preceding_knock_when_names_unreadable():
    # 擊倒的名字讀得到；補刀的畫格全是不相干的殘片（沒有被印證的指紋）→ 以時間配對
    a = sig(7)
    frames = _runs((0.0, "knock", [a, noisy(a, 1), a]),
                   (4.0, "elim", [sig(600), sig(601), sig(602), sig(603)]))
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["knock", "elim"]
    assert ev[1].name_sig == ev[0].name_sig


def test_elim_pairs_when_knock_name_also_unreadable():
    frames = _runs((0.0, "knock", [sig(610), sig(611), sig(612)]),
                   (4.0, "elim", [sig(600), sig(601), sig(602)]))
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].name_sig == ev[0].name_sig


def test_elim_not_paired_when_both_names_readable_and_different():
    a, b = sig(7), sig(8)
    frames = _runs((0.0, "knock", [a, a, a]), (4.0, "elim", [b, b, b]))
    ev, _ = run(frames)
    assert ev[1].name_sig == b.to_b64()


def test_elim_not_paired_beyond_pair_window_or_without_knock():
    frames = _runs((0.0, "knock", [sig(610), sig(611), sig(612)]),
                   (15.0, "elim", [sig(600), sig(601), sig(602)]))
    ev, _ = run(frames)
    assert ev[1].name_sig != ev[0].name_sig
    ev, _ = run(_runs((0.0, "elim", [sig(600), sig(601), sig(602)])))
    assert len(ev) == 1


def test_one_knock_pairs_with_only_one_elim():
    a = sig(7)
    frames = _runs((0.0, "knock", [a, a, a]),
                   (3.0, "elim", [sig(600), sig(601), sig(602)]),
                   (6.0, "elim", [sig(620), sig(621), sig(622)]))
    ev, _ = run(frames)
    assert ev[1].name_sig == ev[0].name_sig       # 第一個補刀吃掉這次擊倒
    assert ev[2].name_sig not in (ev[0].name_sig,)  # 第二個補刀是另一個敵人


def test_assist_elim_pairs_with_assist_knock():
    frames = _runs((0.0, "assist_knock", [sig(610), sig(611), sig(612)]),
                   (4.0, "assist_elim", [sig(600), sig(601), sig(602)]))
    ev, _ = run(frames)
    assert ev[1].name_sig == ev[0].name_sig


def test_knock_after_elim_never_pairs_by_time():
    frames = _runs((0.0, "elim", [sig(610), sig(611), sig(612)]),
                   (4.0, "knock", [sig(600), sig(601), sig(602)]))
    ev, _ = run(frames)
    assert ev[1].name_sig != ev[0].name_sig


def test_pairing_allowed_when_short_name_is_a_fragment_of_the_knock_name():
    # 擊倒讀到完整名字（寬 90）；補刀只讀到被背景／HUD 吃掉的殘片（同一名字的一段，彼此印證）：
    # 殘片是同一敵人的證據，依時間配對（I4：判斷依據改為「滑動相關」而不是寬度）
    a = sig(7, 90)
    frag = crop(a, 20, 45)
    frames = _runs((0.0, "knock", [a, a, a]), (4.0, "elim", [frag, noisy(frag, 1), frag, noisy(frag, 2)]))
    ev, _ = run(frames)
    assert ev[1].name_sig == ev[0].name_sig


def test_pairing_refused_when_wide_name_is_not_related_to_the_knock_name():
    # I4：擊倒 A（寬 60）後 10 秒內，獨立擊殺另一個人 B（寬 120，互相印證）→ 不同敵人，不得配對成重複
    a, b = sig(7, 60), sig(8, 120)
    frames = _runs((0.0, "knock", [a, a, a]), (4.0, "elim", [b, b, b]))
    ev, _ = run(frames)
    assert ev[1].name_sig == b.to_b64() and ev[1].name_sig != ev[0].name_sig


def test_squad_fight_sequence_last_elim_not_paired_to_wrong_knock():
    # I4：擊倒 A、擊倒 B，最後一人 C 直接消滅（名字都讀得到、寬度各異）→ C 是獨立計入
    a, b, c = sig(11, 70), sig(12, 100), sig(13, 55)
    frames = _runs((0.0, "knock", [a, a, a]), (2.0, "knock", [b, b, b]), (5.0, "elim", [c, c, c]))
    ev, _ = run(frames)
    assert [e.name_sig for e in ev] == [a.to_b64(), b.to_b64(), c.to_b64()]


def test_pairing_refused_when_comparable_width_readable_names_differ():
    a, b = sig(7, 60), sig(8, 62)  # 寬度相近、內容不同 → 不同敵人
    frames = _runs((0.0, "knock", [a, a, a]), (4.0, "elim", [b, b, b]))
    ev, _ = run(frames)
    assert ev[1].name_sig == b.to_b64()


# --- Fix-ML-2：同一個助攻橫幅的 assist_knock／assist_elim 閃爍不拆成兩個事件 ---

def test_assist_subkind_flicker_is_one_event_with_majority_type():
    a = sig(7)
    kinds = ["assist_elim", "assist_elim", "assist_knock", "assist_knock", "assist_knock", "assist_knock"]
    frames = [(i * 0.25, fr(k, a)) for i, k in enumerate(kinds)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0 and ev[0].type == "assist_knock"


def test_assist_family_does_not_merge_with_other_kinds():
    a = sig(7)
    frames = [(0.0, fr("assist_knock", a)), (0.25, fr("assist_knock", a)), (0.5, fr("assist_knock", a)),
              (0.75, fr("knock", a)), (1.0, fr("knock", a)), (1.25, fr("knock", a))]
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["assist_knock", "knock"]


def test_recurring_jitter_name_seen_earlier_in_run_does_not_split():
    # 同一橫幅內曾出現過的另一種讀法（抖動）再次連續 2 格出現：與已確認格相符，不算新名字
    a, j, k = sig(1), sig(50), sig(51)
    names = [a, a, a, j, k, noisy(j, 1), noisy(j, 2), a, a]
    frames = [(i * 0.25, fr("knock", n)) for i, n in enumerate(names)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].name_sig == a.to_b64()


# --- 最終審查 I1：無空白格的名字變窄（遮擋／淡出）不是新敵人 ---

def test_i1_occluded_name_fragment_without_gap_does_not_split():
    full = sig(21, 120)
    names = [full, noisy(full, 1), full, noisy(full, 2)] + [crop(full, 10, 60)] * 3
    frames = [(i * 0.25, fr("knock", n)) for i, n in enumerate(names)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    assert ev[0].name_sig == full.to_b64()


def test_i1_fade_out_fragments_of_assist_banner_do_not_split():
    full = sig(22, 100)
    names = [full, noisy(full, 1), full] + [crop(full, 0, 55)] * 2
    frames = [(i * 0.25, fr("assist_knock", n)) for i, n in enumerate(names)]
    ev, _ = run(frames)
    assert len(ev) == 1


def test_i1_unrelated_narrow_name_without_gap_still_splits():
    # 不是殘片（相關性低）→ 仍視為另一個敵人
    a, b = sig(23, 100), sig(24, 55)
    frames = _runs((0.0, "knock", [a, a, a, a]), (1.0, "knock", [b, b, b]))
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].t == 1.0


# --- 最終審查 I2：助攻擊倒 → 助攻消滅（同一敵人）不併成同一個 run ---

def test_i2_assist_knock_then_assist_elim_after_gap_are_two_events():
    a = sig(31, 76)
    frames = _runs((0.0, "assist_knock", [a] * 9), (2.5, "assist_elim", [a] * 9))  # 2.25 空白一格
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["assist_knock", "assist_elim"]
    assert ev[1].name_sig == ev[0].name_sig  # 時間配對／連結 → derive 標為重複


def test_i2_subkind_flicker_in_first_second_still_one_event():
    a = sig(32, 76)
    kinds = ["assist_elim", ".", "assist_knock", "assist_knock", "assist_knock", "assist_knock", "assist_knock"]
    frames = [(i * 0.25, fr(k if k != "." else None, a if k != "." else None)) for i, k in enumerate(kinds)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].type == "assist_knock"


def test_i2_subkind_switch_with_gap_later_in_run_splits():
    a = sig(33, 76)
    kinds = ["assist_knock"] * 8 + ["."] + ["assist_elim"] * 4
    frames = [(i * 0.25, fr(k if k != "." else None, a if k != "." else None)) for i, k in enumerate(kinds)]
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["assist_knock", "assist_elim"]


# --- 最終審查 I3：「再次擊倒」白字名 ---

def test_i3_white_name_knock_uses_alt_sig_for_dedupe_and_pairing():
    w = sig(41, 64)
    frames = [(i * 0.25, fr("knock", None, alt=w)) for i in range(4)]
    frames += _runs((3.0, "elim", [sig(600), sig(601), sig(602), sig(603)]))
    ev, _ = run(frames)
    assert ev[0].name_sig == w.to_b64()          # 不再是 None：後續可去重
    assert ev[1].name_sig == ev[0].name_sig      # 補刀以時間配對到這次再次擊倒


def test_i3_alt_sig_ignored_when_run_has_red_names():
    a, junk = sig(42, 64), sig(43, 64)
    frames = [(0.0, fr("knock", a)), (0.25, fr("knock", None, alt=junk)), (0.5, fr("knock", a)),
              (0.75, fr("knock", None, alt=junk))]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].name_sig == a.to_b64()
