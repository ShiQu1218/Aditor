"""三語言（zh-TW／en／ja）真實畫格 fixture 的偵測測試。

fixture 由各語言「訓練來源」錄影裁出（見 templates/<lang>/PROVENANCE.md 與
docs/accuracy-report-multilang.md）；門檻與下限皆為實測值，不是猜的。
"""
import numpy as np
import pytest

from apexhl.detect import name_sig_similarity, same_name

# 各類型畫面上「合法同時出現」的關鍵字；其餘關鍵字都應明顯低於勝出的關鍵字
_COMPANIONS = {
    "knock": {"knock", "damage", "assist_knock"},
    "assist_knock": {"assist", "knock", "assist_knock"},
    "assist_elim": {"assist", "elim", "elim_done"},
    "elim": {"elim_done", "elim"},
    "squad_wipe": {"squad_wipe"},
}
_WINNER = {"knock": "knock", "assist_knock": "assist", "assist_elim": "assist",
           "elim": "elim_done", "squad_wipe": "squad_wipe"}
# 實測最小「勝出關鍵字領先其他關鍵字」：zh-TW 0.287、en 0.163（含最難的低對比正例）、ja 0.462 → 下限取略低
_MIN_MARGIN = {"zh-TW": 0.25, "en": 0.15, "ja": 0.40}
# 助攻之後 knock/elim 子關鍵字互相的領先：zh-TW 0.519、en 0.50、ja 0.46
_MIN_SUB_MARGIN = {"zh-TW": 0.45, "en": 0.45, "ja": 0.40}
# 門檻須落在「正例最小值」與「外來最大值」之間，且兩側各至少留這麼多
_GAP = 0.05
# 傷害行：真實但對比太低而沒偵測到的畫格（已知限制；目前沒有，en 門檻 0.35 就是為了涵蓋對比 0.44 的實測畫格）
_KNOWN_DAMAGE_MISS: set = set()
# 名字指紋：同敵人配對判為同一人的實測比例（en 70/86、ja 126/134）與不同敵人誤合併 0 次
_SAME_PAIR_FLOOR = {"en": 0.75, "ja": 0.90}


def _detect(ctx, name):
    return ctx.detector.detect(*ctx.load(name))


def test_positive_fixtures(lang_ctx):
    items = lang_ctx.items(kind_not_null=True, exclude_fadein=True)
    assert len(items) >= 30
    for name, lab in items:
        r = _detect(lang_ctx, name)
        assert r.kind == lab["kind"], name
        if lab["kind"] == "knock" and (lang_ctx.lang, name) not in _KNOWN_DAMAGE_MISS:
            assert r.damage_line == lab["damage_line"], name


def test_every_kind_has_enough_samples(lang_ctx):
    """各類型樣本數（沒有真實樣本的類型明確列出，見 PROVENANCE 與準確度報告）。"""
    have = {k: len(lang_ctx.items(kind=k, exclude_fadein=True))
            for k in ("knock", "assist_knock", "assist_elim", "elim", "squad_wipe")}
    no_sample = {"en": {"assist_elim"}, "ja": {"elim"}}.get(lang_ctx.lang, set())
    for kind, n in have.items():
        if kind in no_sample:
            assert n == 0, (lang_ctx.lang, kind)  # 若之後補到真樣本，請更新這份清單
        else:
            assert n >= 5, (lang_ctx.lang, kind, n)


def test_negative_fixtures(lang_ctx):
    items = lang_ctx.items(kind_null=True)
    assert len(items) >= 40
    for name, lab in items:
        assert _detect(lang_ctx, name).kind is None, name


def test_fadein_frames_may_be_missed(lang_ctx):
    items = [(n, lab) for n, lab in lang_ctx.items(kind_not_null=True) if lab.get("fadein")]
    assert items
    for name, lab in items:
        assert _detect(lang_ctx, name).kind in (None, lab["kind"]), name


def test_spectating_fixtures(lang_ctx):
    items = lang_ctx.items()
    assert any(lab["spectating"] for _, lab in items)
    for name, lab in items:
        assert _detect(lang_ctx, name).spectating == lab["spectating"], name


def test_keyword_distinctness_margin(lang_ctx):
    for name, lab in lang_ctx.items(kind_not_null=True, exclude_fadein=True):
        sc = lang_ctx.detector.keyword_scores(lang_ctx.load(name)[0])
        kind = lab["kind"]
        others = max(v for k, v in sc.items() if k not in _COMPANIONS[kind])
        assert sc[_WINNER[kind]] - others >= _MIN_MARGIN[lang_ctx.lang], (name, sc)
        sub_knock = "assist_knock" if "assist_knock" in sc else "knock"
        if kind == "assist_knock":
            assert sc[sub_knock] - sc["elim"] >= _MIN_SUB_MARGIN[lang_ctx.lang], (name, sc)
        if kind == "assist_elim":
            assert sc["elim"] - sc[sub_knock] >= _MIN_SUB_MARGIN[lang_ctx.lang], (name, sc)


def _scores(ctx):
    rows = []
    for name, lab in ctx.items(exclude_fadein=True):
        rows.append((lab["kind"], lab["damage_line"], ctx.detector.keyword_scores(ctx.load(name)[0])))
    return rows


def test_thresholds_sit_inside_measured_gap(lang_ctx):
    """每個關鍵字門檻：落在（可到達該檢查的）正例最小值與外來最大值之間，各留 _GAP。"""
    rows = _scores(lang_ctx)
    K = {None, "knock", "assist_knock", "assist_elim", "elim", "squad_wipe"}
    # (key, 正例 kind 集合, 外來 kind 集合)；外來＝偵測順序上會走到該檢查、但不該命中的畫面
    spec = [("squad_wipe", {"squad_wipe"}, K - {"squad_wipe"}),
            ("assist", {"assist_knock", "assist_elim"}, {None, "knock", "elim"}),
            ("knock", {"knock"}, {None, "elim"}),
            ("elim_done", {"elim"}, {None, "knock"})]
    d = lang_ctx.detector
    for key, pos_kinds, foreign_kinds in spec:
        pos = [sc[key] for k, _, sc in rows if k in pos_kinds]
        foreign = [sc[key] for k, _, sc in rows if k in foreign_kinds]
        thr = d.thr[key]
        assert foreign and max(foreign) + _GAP <= thr, (lang_ctx.lang, key, thr, max(foreign))
        if pos:
            assert thr + _GAP <= min(pos), (lang_ctx.lang, key, thr, min(pos))
    dmg_pos = [sc["damage"] for k, dl, sc in rows if k == "knock" and dl]
    dmg_foreign = [sc["damage"] for k, _, sc in rows if k in (None, "elim")]
    assert max(dmg_foreign) + _GAP <= d.thr["damage"]
    assert d.thr["damage"] + _GAP <= min(dmg_pos)


def test_name_sig_pairs_on_real_fixtures(new_lang_ctx):
    ctx = new_lang_ctx
    items = []
    for n, lab in ctx.items(kind_not_null=True, exclude_fadein=True):
        if lab["kind"] != "squad_wipe" and lab["enemy"]:
            items.append((n, lab["enemy"], _detect(ctx, n).name_sig))
    thr = ctx.profile.name_sig_threshold
    same, diff = [], []
    for i, (na, ea, sa) in enumerate(items):
        for nb, eb, sb in items[i + 1:]:
            if sa is None or sb is None:
                continue
            (same if ea == eb else diff).append(same_name(sa, sb, thr))
    assert len(same) >= 50 and len(diff) >= 400
    assert sum(same) / len(same) >= _SAME_PAIR_FLOOR[ctx.lang], (sum(same), len(same))
    assert not any(diff)  # 不同敵人從不被合併


def test_name_sig_shape(new_lang_ctx):
    ctx = new_lang_ctx
    for name, lab in ctx.items(kind_not_null=True, exclude_fadein=True):
        sig = _detect(ctx, name).name_sig
        if lab["kind"] == "squad_wipe":
            assert sig is None, name
            continue
        if sig is None:  # 少數畫格名字被背景吃掉（ML-2 追蹤）；不得超過 10%（實測 en 2/37、ja 0）
            continue
        assert sig.bits.shape == (16, sig.width), name
        assert set(np.unique(sig.bits)) <= {0, 1}
        assert 8 <= sig.width <= 400, name
    nones = [n for n, lab in ctx.items(kind_not_null=True, exclude_fadein=True)
             if lab["kind"] != "squad_wipe" and _detect(ctx, n).name_sig is None]
    total = len([1 for _, lab in ctx.items(kind_not_null=True, exclude_fadein=True)
                 if lab["kind"] != "squad_wipe"])
    assert len(nones) <= max(1, int(0.10 * total)), nones


def test_blank_banner_all_languages(lang_ctx):
    r = lang_ctx.detector.detect(np.zeros((180, 800, 3), np.uint8), np.zeros((40, 480, 3), np.uint8))
    assert r.kind is None and not r.spectating and r.name_sig is None


def test_profile_flags(lang_ctx):
    p = lang_ctx.profile
    if lang_ctx.lang == "ja":
        assert p.name_side == "left" and p.name_between_assist and "skull" in p.keywords
    else:
        assert p.name_side == "right" and not p.name_between_assist
    assert not p.veto_supported or lang_ctx.lang == "zh-TW"  # en/ja 無真實否決橫幅樣本
    assert p.spectating_supported == bool(p.spec_templates)


def test_ja_skull_threshold_inside_gap():
    """ja 的 skull 範本（從 English.mkv 獨立擊殺橫幅裁出，圖示與語言無關）：
    正例＝en 獨立擊殺 fixture（非淡入）最小 0.824；外來＝全部 ja fixture 第一行帶最大 0.630。"""
    from conftest import LangCtx
    from apexhl.detect import _match, white_mask
    ja, en = LangCtx("ja"), LangCtx("en")
    tpl = ja.detector.tpl["skull"]
    thr = ja.profile.keywords["skull"].threshold

    def best(ctx, name):
        wm = white_mask(ctx.load(name)[0], ja.profile)
        return _match(wm[50:108], tpl)[0]

    pos = [best(en, n) for n, lab in en.items(kind="elim", exclude_fadein=True)]
    foreign = [best(ja, n) for n, _ in ja.items()]
    assert len(pos) >= 5 and max(foreign) + _GAP <= thr <= min(pos) - _GAP


def test_yellow_names_colorblind_mode(lang_ctx):
    """色盲模式（紅色盲／藍色盲）敵人名字為黃色：把真實 knock fixture 的紅字名像素改成黃色
    （與使用者提供的黃名截圖同一色相，BGR≈(59,171,180)），名字指紋必須仍可取得並與紅名版本判為同一人。
    關鍵字比對只用白字遮罩，與名字顏色無關。"""
    import numpy as np
    from apexhl.detect import red_mask
    ctx = lang_ctx
    done = 0
    for name, lab in ctx.items(kind="knock", exclude_fadein=True):
        banner, spec = ctx.load(name)
        red = red_mask(banner, ctx.profile) > 0
        if red.sum() < 150:
            continue
        yellow = banner.copy()
        yellow[red] = (59, 171, 180)
        a, b = ctx.detector.detect(banner, spec), ctx.detector.detect(yellow, spec)
        assert b.kind == "knock"
        if a.name_sig is None:
            continue
        assert b.name_sig is not None, name
        assert same_name(a.name_sig, b.name_sig, ctx.profile.name_sig_threshold), name
        done += 1
        if done >= 5:
            break
    assert done >= 3
