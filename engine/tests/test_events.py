import numpy as np

from apexhl.events import EventTracker
from apexhl.models import FrameResult, NameSig
from apexhl.profile import load_profile
from pathlib import Path

PROFILE = load_profile(Path(__file__).resolve().parents[2] / "templates" / "icons")

def sig(seed: int, width: int = 60) -> NameSig:
    rng = np.random.default_rng(seed)
    return NameSig(width, (rng.random((16, width)) > 0.5).astype(np.uint8))


def fr(kind=None, name=None, spec=False, score=0.9, damage=False, hint=None):
    return FrameResult(kind=kind, score=score, x=0, damage_line=damage, name_sig=name, spectating=spec,
                       hint=hint)


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
    # 兩則橫幅之間有淡出（一格空白）→ 不同敵人（最終審查 I1：無空白的名字改變不再分裂，見下方）
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a) + seq("KKK", name=b, t0=1.0)
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].t == 1.0
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
    # 別種橫幅（獨立消滅、小隊抹殺等）只有 1 格：不成事件，也不接在擊倒上
    frames = seq("KKK", kind="knock") + [(0.75, fr(hint="other"))] + seq("..", t0=1.0)
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
    frames = seq("KKK", name=a) + seq("KK", name=b, t0=1.0)  # 中間一格空白
    ev, _ = run(frames)
    assert [e.t for e in ev] == [0.0, 1.0]
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
    frames = [(i * 0.25, fr("knock", jit[i])) for i in range(4)]
    frames += [(1.0 + i * 0.25, fr("knock", stable)) for i in range(3)]
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
    frames = [(i * 0.25, fr("knock", n)) for i, n in enumerate(names)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    got = NameSig.from_b64(ev[0].name_sig)
    assert same_name(got, good, PROFILE.name_sig_threshold)


def test_jitter_between_two_enemies_still_splits_once():
    a, b = sig(1), sig(2)
    frames = seq("KKK", name=a)
    frames += [(1.0, fr("knock", sig(400))), (1.25, fr("knock", sig(401)))]  # 空白一格後，兩格各自不同的抖動
    frames += seq("KKK", name=b, t0=1.5)
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[0].t == 0.0 and ev[1].t == 1.0  # 新橫幅從空白格之後的第一格起算（名字抖動格也是新橫幅）
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


def _runs(*parts):
    """parts: (t0, kind, [名字指紋...])，每個指紋一格 (0.25s)。"""
    frames = []
    for t0, kind, names in parts:
        frames += [(t0 + i * 0.25, fr(kind, n)) for i, n in enumerate(names)]
    return frames


# --- Fix-ML-2：同一個助攻橫幅的 assist_knock／assist_elim 閃爍不拆成兩個事件 ---

def test_kind_flicker_is_one_event_with_majority_type():
    # 擊倒／助攻擊倒共用同一個圖示，淡入時線索讀不準：短暫的閃爍不拆事件，類型取多數
    a = sig(7)
    kinds = ["knock", "knock", "assist_knock", "assist_knock", "assist_knock", "assist_knock"]
    frames = [(i * 0.25, fr(k, a)) for i, k in enumerate(kinds)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0 and ev[0].type == "assist_knock"


def test_kind_flicker_in_the_middle_does_not_split():
    kinds = ["knock"] * 4 + ["assist_knock"] * 2 + ["knock"] * 4
    ev, _ = run([(i * 0.25, fr(k)) for i, k in enumerate(kinds)])
    assert len(ev) == 1 and ev[0].type == "knock"


def test_persistent_kind_change_without_gap_splits_at_first_frame_of_new_kind():
    kinds = ["knock"] * 5 + ["assist_knock"] * 5
    ev, _ = run([(i * 0.25, fr(k)) for i, k in enumerate(kinds)])
    assert [(e.t, e.type) for e in ev] == [(0.0, "knock"), (1.25, "assist_knock")]


def test_cont_frames_extend_a_banner_but_do_not_count_as_hits():
    frames = seq("KKK") + [(0.75, fr(hint="cont")), (1.0, fr(hint="cont"))] + seq("KK", t0=1.25)
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
    ev, _ = run([(0.0, fr(hint="cont")), (0.25, fr(hint="cont"))])
    assert ev == []


def test_other_banner_ends_the_current_event():
    frames = seq("KKK") + [(0.75, fr(hint="other"))] + seq("KKK", t0=1.0)
    ev, _ = run(frames)
    assert [e.t for e in ev] == [0.0, 1.0]


def test_assist_elim_is_its_own_family():
    frames = seq("KKK", kind="knock") + seq("HHH", kind="assist_elim", t0=0.75)
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["knock", "assist_elim"]


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


def test_i1_unrelated_name_without_gap_or_score_dip_is_jitter():
    # 實測（held-out）：HUD 遮擋後剩下的墨寬度驟降、內容與原名字無關（不是裁切殘片），分數不變、沒有空白格。
    # 遊戲同一時間只有一個中央橫幅，換敵人必有淡出（空白）或分數凹陷 → 這種變化併入同一個 run
    a, b = sig(23, 300), sig(24, 55)
    frames = _runs((0.0, "knock", [a, a, a, a, a, a]), (1.5, "knock", [b, b]))
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].name_sig == a.to_b64()


def test_i1_unrelated_name_after_gap_splits():
    a, b = sig(23, 100), sig(24, 55)
    frames = _runs((0.0, "knock", [a, a, a, a]), (1.25, "knock", [b, b, b]))  # 一格空白
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].t == 1.25


def test_i1_unrelated_name_with_score_dip_splits():
    a, b = sig(25, 100), sig(26, 80)
    frames = [(i * 0.25, fr("knock", a, score=0.9)) for i in range(4)]
    frames += [(1.0, fr("knock", b, score=0.6)), (1.25, fr("knock", b, score=0.6)), (1.5, fr("knock", b, score=0.9))]
    ev, _ = run(frames)
    assert len(ev) == 2 and ev[1].t == 1.0


# --- 最終審查 I2：助攻擊倒 → 助攻消滅（同一敵人）不併成同一個 run ---

def test_i2_assist_knock_then_assist_elim_are_two_events():
    a = sig(31, 76)
    frames = _runs((0.0, "assist_knock", [a] * 9), (2.5, "assist_elim", [a] * 9))  # 2.25 空白一格
    ev, _ = run(frames)
    assert [e.type for e in ev] == ["assist_knock", "assist_elim"]


def test_i2_assist_elim_blip_before_assist_knock_banner_is_not_an_event():
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


# --- 驗收片回歸（test-ENG 510.0）：背靠背不同敵人，中間只有一格「彈出」空白 ---

def test_real_banner_replacement_after_blank_frame_is_not_absorbed_by_junk_sigs():
    # 舊橫幅內曾出現過幾格雜訊指紋（遮擋／火光），其中一個碰巧與新名字互為殘片；
    # 空白格之後出現的新橫幅只能和 run 的代表簽名（或其殘片）比對，不能被雜訊指紋吸收
    a, b = sig(51, 75), sig(52, 110)
    junk1, junk2 = crop(b, 20, 45), crop(b, 40, 50)
    names = [a, a, a, a, junk1, junk1, a, a]
    frames = [(i * 0.25, fr("knock", n)) for i, n in enumerate(names)]
    frames += [(2.25 + i * 0.25, fr("knock", b)) for i in range(5)]   # 1.75 之後只空白一格（2.0），2.25 起新橫幅；t 差 0.5 仍在同 run 容許內
    ev, _ = run(frames)
    assert [e.t for e in ev] == [0.0, 2.25] and ev[1].name_sig == b.to_b64()


def test_blank_gap_inside_banner_with_same_name_still_one_event():
    a = sig(53, 75)
    frames = [(i * 0.25, fr("knock", a if i != 4 else None)) for i in range(10)]
    ev, _ = run(frames)
    assert len(ev) == 1


def test_new_banner_after_blank_starts_at_first_frame_even_if_name_unreadable_for_a_while():
    # test-ENG 510.0：彈出空白格之後的新橫幅，前幾格名字讀不到、之後才讀到另一個名字；
    # 新事件的 t 必須是空白格後的第一格（橫幅最早出現），而不是名字讀到的那格
    a, b = sig(61, 75), sig(62, 100)
    frames = [(i * 0.25, fr("knock", a)) for i in range(6)]                 # 0 – 1.25
    frames += [(1.75 + i * 0.25, fr("knock", None)) for i in range(6)]      # 1.5 空白一格；1.75 – 3.0 名字讀不到
    frames += [(3.25 + i * 0.25, fr("knock", b)) for i in range(4)]
    ev, _ = run(frames)
    assert [e.t for e in ev] == [0.0, 1.75] and ev[1].name_sig == b.to_b64()
    assert ev[0].name_sig == a.to_b64()


def test_blank_then_unreadable_then_same_name_is_still_one_event():
    a = sig(63, 75)
    frames = [(i * 0.25, fr("knock", a)) for i in range(6)]
    frames += [(1.75 + i * 0.25, fr("knock", None)) for i in range(3)] + [(2.5 + i * 0.25, fr("knock", a)) for i in range(3)]
    ev, _ = run(frames)
    assert len(ev) == 1 and ev[0].t == 0.0
