"""事件追蹤器：把逐格 FrameResult 聚成事件（連續橫幅切分、名字抖動容忍、觀戰區間）。

事件單位是「橫幅第一次出現」：同一個橫幅的連續命中格（容許 1 格空白）是一個 run；run 內的類型取多數。
切分有兩個來源：
1. 名字指紋（只有擊倒橫幅有：敵人名字色，與語言無關）：同一 run 內名字改變，且之間有空白格或分數凹陷才切
   （無空白、無凹陷的改變視為 HUD 遮擋／淡出的抖動）。
2. 類型持續改變：擊倒與助攻擊倒共用同一個圖示，由名字色／第二行線索判斷；同一個 run 內類型持續改變
   （兩側各 ≥ KIND_PERSIST 格）視為兩個接連的橫幅，短暫的閃爍併入前後。
"""
from __future__ import annotations

from bisect import bisect_left

from apexhl.detect import fragment_of as fragment_related
from apexhl.detect import same_name
from apexhl.models import Event, FrameResult, NameSig, SpecInterval
from apexhl.profile import Profile

STEP = 0.25
GAP = 0.5          # 提示消失（無命中）≥ 0.5 秒 = 連續 2 格空白才算新事件
SPEC_MIN_FRAMES = 8  # 觀戰連續 ≥ 2 秒
_EPS = 1e-6

SPLIT_SCORE_DIP = 0.12   # 圖示分數凹陷（相對於 run 內的中位數）達這麼多，視為橫幅被換掉的不連續點
KIND_PERSIST = 3         # 同一 run 內擊倒／助攻擊倒類型要持續幾格才切成兩個事件
_MAX_SIGS = 40  # 每個 run 最多納入代表簽名計算的指紋數（橫幅最長約 10 秒 = 40 格；超過者仍參與比對但不入池）
_P_KINDS = frozenset({"knock", "assist_knock"})


def _family(kind: str | None) -> str | None:
    """同一個橫幅的家族：單人加分（擊倒／助攻擊倒，圖示相同）＝P；助攻消滅（握手）＝H。"""
    if kind in _P_KINDS:
        return "P"
    return "H" if kind == "assist_elim" else None


class _Run:
    """同一個橫幅的連續命中；彙整整段 run 的所有命中格。

    名字比對用「代表簽名」（run 內的 medoid／多數）而不是前一格：指紋逐格抖動時，
    單格差異只算雜訊，不會讓整段連續命中被丟棄，也不會把同一橫幅切成兩個事件。
    """

    def __init__(self, threshold: float, suppressed: bool):
        self.threshold = threshold
        self.suppressed = suppressed
        self.frames: list[tuple[float, FrameResult]] = []  # 本 run 的所有命中格（含暫列格）
        self.cont_ts: list[float] = []  # 「有加分箭頭但人形不確定」格的時間（延續 run，不算命中）
        self.event: Event | None = None
        # 暫列格：與代表簽名不同的最新一格，需下一格也是同一個新名字才確認分裂
        self.pending: tuple[float, FrameResult] | None = None
        self.discontinuity = False  # 最後一個「與本 run 名字相符」的畫格之後，是否出現過空白格（橫幅淡出）
        self.disc_idx: int | None = None  # 空白格之後第一格在 frames 的索引（若之後確認是新橫幅，新事件從這格起算）
        self._sigs: list[NameSig] = []   # 已確認（非暫列）格的指紋，依時間排序
        self._support: list[int] = []    # 與各指紋「同一人」的其他指紋數
        self._counts: dict[str, tuple[int, int]] = {}  # 類型 → (格數, 最後出現索引)
        self._score = 0.0
        self._damage = False
        self._times: list[float] = []  # 確認連續兩格前的有橫幅時間，依時間排序
        self._has_pair = False

    # --- 彙整 ---
    @property
    def family(self) -> str | None:
        return _family(self.frames[0][1].kind)

    @property
    def kind(self) -> str | None:
        """run 的類型：畫格類型的多數（同數取較晚者）。淡入時圖示線索讀不準，多數決讓整段穩定。"""
        return max(self._counts, key=self._counts.__getitem__)

    @property
    def first_t(self) -> float:
        return self.frames[0][0]

    @property
    def last_t(self) -> float:
        return self.frames[-1][0]

    @property
    def reach_t(self) -> float:
        """最後一格「有橫幅跡象」的時間（含 cont 格）：判斷連續性用。"""
        return max([self.last_t, *self.cont_ts])

    @property
    def score(self) -> float:
        return self._score

    @property
    def damage(self) -> bool:
        return self._damage

    @property
    def has_pair(self) -> bool:
        return self._has_pair

    @property
    def stable(self) -> bool:
        """已確認格中是否有兩個指紋互為同一人（否則指紋不可靠，不據以分裂）。"""
        return any(c >= 1 for c in self._support)

    # --- 代表簽名 ---
    def _register(self, sig: NameSig) -> None:
        if len(self._sigs) >= _MAX_SIGS:
            return
        sup = 0
        for i, o in enumerate(self._sigs):
            if same_name(o, sig, self.threshold):
                self._support[i] += 1
                sup += 1
        self._sigs.append(sig)
        self._support.append(sup)

    def representative(self) -> NameSig | None:
        """medoid：與最多其他指紋判為同一人的指紋（多數）；同分取最早的。
        乾淨的 run（全部互為同一人）因此回傳第一個指紋。"""
        if not self._sigs:
            return None
        best = max(range(len(self._sigs)), key=lambda i: (self._support[i], -i))
        return self._sigs[best]

    def reset(self, frames: list[tuple[float, FrameResult]], cont_ts: list[float] | None = None) -> None:
        """以給定畫格重建本 run 的彙整狀態（分裂時把後半段移給新 run）。"""
        self.frames, self.pending = [], None
        self.cont_ts = []
        self._sigs, self._support = [], []
        self._counts, self._times = {}, []
        self._score, self._damage, self._has_pair = 0.0, False, False
        self.discontinuity, self.disc_idx = False, None
        for t, r in frames:
            self.add(t, r)
        for t in cont_ts or []:
            if frames and t >= frames[0][0]:
                self.add_cont(t)

    # --- 變更 ---
    def _add_time(self, t: float) -> None:
        if self._has_pair:
            return
        # reset 時命中格與 cont 格分別重放，插入相鄰位置即可確認是否有連續兩格。
        i = bisect_left(self._times, t)
        self._has_pair = ((i > 0 and t - self._times[i - 1] < STEP + _EPS)
                          or (i < len(self._times) and self._times[i] - t < STEP + _EPS))
        self._times.insert(i, t)

    def add_cont(self, t: float) -> None:
        self.cont_ts.append(t)
        self._add_time(t)

    def add(self, t: float, r: FrameResult, *, tentative: bool = False) -> None:
        i = len(self.frames)
        self.frames.append((t, r))
        count, _ = self._counts.get(r.kind, (0, 0))
        self._counts[r.kind] = (count + 1, i)
        self._score = r.score if i == 0 else max(self._score, r.score)
        self._damage = self._damage or r.damage_line
        self._add_time(t)
        if tentative:
            self.pending = (t, r)
            return
        self.pending = None
        if r.name_sig is not None:
            self._register(r.name_sig)

    def commit_pending(self) -> None:
        """暫列格被新的暫列格取代：視為本 run 內的抖動，併入已確認格。"""
        if self.pending is not None:
            sig = self.pending[1].name_sig
            if sig is not None:
                self._register(sig)
            self.pending = None

    def kind_cut(self) -> int | None:
        """類型持續改變的切點（frames 索引）；沒有則 None。

        P 家族逐格為擊倒（true）或助攻擊倒（false）；同值連續段 ≥ KIND_PERSIST 格才算「穩定段」
        （較短的段是閃爍，併入前後）；相鄰穩定段值不同 → 在後者第一格切開。"""
        if self.family != "P":
            return None
        segs: list[list] = []  # [值, 第一個 frames 索引, 格數]
        for i, (_, r) in enumerate(self.frames):
            v = r.kind == "knock"
            if segs and segs[-1][0] == v:
                segs[-1][2] += 1
            else:
                segs.append([v, i, 1])
        prev = None
        for v, first, n in segs:
            if n < KIND_PERSIST:
                continue
            if prev is not None and v != prev:
                return first
            prev = v
        return None

    def matches_representative(self, r: FrameResult) -> bool:
        """只和代表簽名比：同名或殘片關係；沒有名字／run 還沒有名字不算矛盾。"""
        rep = self.representative()
        if r.name_sig is None or rep is None:
            return True
        return same_name(rep, r.name_sig, self.threshold) or fragment_related(rep, r.name_sig)

    def matches(self, r: FrameResult) -> bool:
        """這格的名字是否屬於本 run：與代表簽名、或任何已確認格的簽名相符就算（沒有名字不算矛盾）。"""
        if r.name_sig is None or not self._sigs:
            return True
        if any(same_name(o, r.name_sig, self.threshold) for o in [self.representative(), *self._sigs]):
            return True
        # 被 HUD 遮擋／淡出而變窄的殘片仍是同一個名字：不算矛盾，併入本 run
        return any(fragment_related(o, r.name_sig) for o in self._sigs)


class EventTracker:
    def __init__(self, profile: Profile, *, resume_start: float | None = None):
        self._threshold = profile.name_sig_threshold
        self._resume_start = resume_start
        self._events: list[Event] = []
        self._run: _Run | None = None
        self._spec_first: float | None = None
        self._spec_last = 0.0
        self._spec_n = 0
        self._intervals: list[SpecInterval] = []

    def feed(self, t: float, r: FrameResult) -> None:
        self._feed_banner(t, r)
        self._feed_spec(t, r)

    def snapshot(self) -> tuple[list[Event], list[SpecInterval]]:
        """目前進度的事件與觀戰區間複本（不結束串流；進行中且已達 2 秒的觀戰區間一併列入）。"""
        events = [Event.from_dict(e.to_dict()) for e in self._events]
        intervals = [SpecInterval(i.start, i.end) for i in self._intervals]
        if self._spec_first is not None and self._spec_n >= SPEC_MIN_FRAMES:
            intervals.append(SpecInterval(self._spec_first, self._spec_last + STEP))
        return events, intervals

    def finish(self) -> tuple[list[Event], list[SpecInterval]]:
        self._flush_spec()
        self._run = None
        return self._events, self._intervals

    # --- 提示橫幅 ---
    def _feed_banner(self, t: float, r: FrameResult) -> None:
        run = self._run
        if r.kind is None:
            if run is None:
                return
            if r.hint == "cont" and run.family == "P" and t - run.reach_t - STEP < GAP - _EPS:
                run.add_cont(t)
                self._emit(run)
            return
        fam = _family(r.kind)
        if run is not None and t - run.reach_t - STEP < GAP - _EPS and run.family == fam:
            # 空白格（橫幅「彈出」換場）之後的第一格只和 run 的代表簽名（或其殘片）比對：run 內遮擋／火光造成的
            # 雜訊指紋不能把另一個敵人的新橫幅吸收進來（驗收片 test-ENG 背靠背兩個敵人）
            gap = t - run.reach_t > STEP + _EPS
            if gap and not run.discontinuity:
                run.discontinuity, run.disc_idx = True, len(run.frames)
            rep_before = run.representative()
            if (run.matches_representative(r) if run.discontinuity else run.matches(r)):
                run.add(t, r)
                # 空白格之後要有一格「讀得到名字、且與代表簽名相符」才算確認是同一橫幅；
                # 新橫幅的名字常要幾格才讀得到，讀不到名字的格先保持待確認
                if r.name_sig is not None and (rep_before is None or run.matches_representative(r)):
                    run.discontinuity, run.disc_idx = False, None
            else:
                pend = run.pending
                if (pend is not None and t - pend[0] < STEP + _EPS
                        and same_name(pend[1].name_sig, r.name_sig, self._threshold)):
                    if run.stable:
                        if self._is_break(run, pend, r):
                            self._split(run, pend, t, r)
                            return
                        # 沒有任何不連續（無空白格、分數沒凹陷）的名字改變 = HUD 遮擋／淡出造成的抖動：
                        # 遊戲同一時間只顯示一個中央橫幅，換成另一個敵人的橫幅一定會經過淡出（空白）或分數凹陷
                        run.commit_pending()
                        run.add(t, r)
                        self._emit(run)
                        return
                    # 舊 run 從未有過穩定名字（亮／藍背景抖動）：視為同一提示，改採穩定後的名字
                    run.commit_pending()
                    run.add(t, r)
                else:
                    run.commit_pending()
                    run.add(t, r, tentative=True)  # 候選分裂點；先當成本 run 的延續（連續格數照算）
            cut = run.kind_cut()
            if cut is not None:
                self._cut_kind(run, cut)
                return
            self._emit(run)
            return
        suppressed = (self._resume_start is not None
                      and abs(t - self._resume_start) < _EPS)
        self._run = run = _Run(self._threshold, suppressed)
        run.add(t, r)

    @staticmethod
    def _is_break(run: _Run, pend: tuple[float, FrameResult], r: FrameResult) -> bool:
        """舊 run 與「新名字」之間有沒有不連續：舊名字最後出現之後有空白格，或圖示分數明顯凹陷。"""
        if run.discontinuity:
            return True
        base = sorted(f.score for _, f in run.frames[:-1])
        if not base:
            return False
        ref = base[len(base) // 2]
        return min(pend[1].score, r.score) < ref - SPLIT_SCORE_DIP

    def _move_tail(self, old: _Run, idx: int) -> _Run:
        """把 old.frames[idx:] 移給新 run（old 只保留前半）；舊事件依剩餘畫格撤回或更新。回傳新 run（已設為目前 run）。"""
        moved = old.frames[idx:]
        cont = list(old.cont_ts)
        old.reset(old.frames[:idx], cont)
        if old.event is not None and not old.has_pair:
            self._events.remove(old.event)  # 舊 run 少了這些格後不足連續 2 格：撤回先前發出的事件
            old.event = None
        elif old.event is not None:
            self._emit(old)
        new = self._run = _Run(self._threshold, False)
        new.reset(moved, cont)
        return new

    def _split(self, old: _Run, pend: tuple[float, FrameResult], t: float, r: FrameResult) -> None:
        """不同名字連續 2 格才分裂。

        一般情況新事件從第一個不同格（暫列格）起算；若舊 run 的名字最後出現後有空白格（橫幅換場），
        新事件從空白格之後的第一格起算（新橫幅的名字常要幾格才讀得到，這些格不屬於舊橫幅）。"""
        idx = old.disc_idx if (old.discontinuity and old.disc_idx is not None) else len(old.frames) - 1
        idx = min(idx, len(old.frames) - 1)
        new = self._move_tail(old, idx)
        new.add(t, r)
        self._emit(new)

    def _cut_kind(self, old: _Run, idx: int) -> None:
        """類型持續改變：從穩定的新類型第一格切成新事件。"""
        new = self._move_tail(old, idx)
        self._emit(new)

    def _emit(self, run: _Run) -> None:
        if run.has_pair and not run.suppressed:
            if run.event is None:
                run.event = Event(id=f"a{int(round(run.first_t * 1000))}", t=run.first_t,
                                  type=run.kind, score=run.score,
                                  damage_line=run.damage, name_sig=None)
                self._events.append(run.event)
            run.event.type = run.kind
            run.event.score = run.score
            run.event.damage_line = run.damage
            rep = run.representative()
            if rep is not None:
                run.event.name_sig = rep.to_b64()

    # --- 觀戰 ---
    def _feed_spec(self, t: float, r: FrameResult) -> None:
        if r.spectating:
            if self._spec_first is None:
                self._spec_first = t
                self._spec_n = 0
            self._spec_n += 1
            self._spec_last = t
        else:
            self._flush_spec()

    def _flush_spec(self) -> None:
        if self._spec_first is not None and self._spec_n >= SPEC_MIN_FRAMES:
            self._intervals.append(SpecInterval(self._spec_first, self._spec_last + STEP))
        self._spec_first = None
        self._spec_n = 0
