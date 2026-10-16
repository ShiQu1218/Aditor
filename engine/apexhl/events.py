from __future__ import annotations

from apexhl.detect import same_name
from apexhl.models import COUNTING_TYPES, Event, FrameResult, NameSig, SpecInterval
from apexhl.profile import Profile

STEP = 0.25
GAP = 0.5          # 提示消失（無命中）≥ 0.5 秒 = 連續 2 格空白才算新事件
SPEC_MIN_FRAMES = 8  # 觀戰連續 ≥ 2 秒
_EPS = 1e-6


LINK_WINDOW = 30.0   # 跨橫幅「同一敵人」連結的時間視窗（秒）：擊倒後補刀通常在這之內
PAIR_WINDOW = 10.0   # 補刀接在擊倒之後多少秒內視為同一敵人（時間配對）
LINK_MIN_WIDTH = 24  # 參與連結的指紋最小寬度（再窄的殘片相關性不可靠）
_KNOCK_TYPES = frozenset({"knock", "assist_knock"})
_FINISH_TYPES = frozenset({"elim", "assist_elim"})
_ASSIST_KINDS = frozenset({"assist_knock", "assist_elim"})
_MAX_SIGS = 40  # 每個 run 最多納入代表簽名計算的指紋數（橫幅最長約 10 秒 = 40 格；超過者仍參與比對但不入池）


class _Run:
    """同一個提示（kind + 名字）的連續命中；彙整整段 run 的所有命中格。

    名字比對用「代表簽名」（run 內的 medoid／多數）而不是前一格：指紋逐格抖動時，
    單格差異只算雜訊，不會讓整段連續命中被丟棄，也不會把同一橫幅切成兩個事件。
    """

    def __init__(self, threshold: float, suppressed: bool):
        self.threshold = threshold
        self.suppressed = suppressed
        self.frames: list[tuple[float, FrameResult]] = []  # 本 run 的所有命中格（含暫列格）
        self.event: Event | None = None
        # 暫列格：與代表簽名不同的最新一格，需下一格也是同一個新名字才確認分裂
        self.pending: tuple[float, FrameResult] | None = None
        self.paired = False  # 這次擊倒是否已被某個補刀配對
        self._sigs: list[NameSig] = []   # 已確認（非暫列）格的指紋，依時間排序
        self._support: list[int] = []    # 與各指紋「同一人」的其他指紋數

    # --- 彙整 ---
    @property
    def kind(self) -> str | None:
        """run 的類型：畫格類型的多數（同數取較晚者）。助攻橫幅淡入時子關鍵字常讀不準，多數決讓整段穩定。"""
        counts: dict[str, int] = {}
        for _, r in self.frames:
            counts[r.kind] = counts.get(r.kind, 0) + 1
        top = max(counts.values())
        for _, r in reversed(self.frames):
            if counts[r.kind] == top:
                return r.kind
        return None

    def accepts(self, kind: str | None) -> bool:
        """這個 run 能不能接納該類型的畫格：同類型，或同屬助攻家族（assist_knock／assist_elim）。"""
        k = self.kind
        return kind == k or (kind in _ASSIST_KINDS and k in _ASSIST_KINDS)

    @property
    def first_t(self) -> float:
        return self.frames[0][0]

    @property
    def last_t(self) -> float:
        return self.frames[-1][0]

    @property
    def score(self) -> float:
        return max(r.score for _, r in self.frames)

    @property
    def damage(self) -> bool:
        return any(r.damage_line for _, r in self.frames)

    @property
    def has_pair(self) -> bool:
        ts = [t for t, _ in self.frames]
        return any(b - a < STEP + _EPS for a, b in zip(ts, ts[1:]))

    @property
    def stable(self) -> bool:
        """已確認格中是否有兩個指紋互為同一人（否則指紋不可靠，不據以分裂）。"""
        return any(c >= 1 for c in self._support)

    # --- 代表簽名 ---
    def _register(self, sig: NameSig) -> None:
        n = len(self._sigs)
        if n >= _MAX_SIGS:
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
        乾淨的 run（全部互為同一人）因此回傳第一個指紋，與逐格追蹤的舊行為相同。"""
        if not self._sigs:
            return None
        best = max(range(len(self._sigs)), key=lambda i: (self._support[i], -i))
        return self._sigs[best]

    # --- 變更 ---
    def add(self, t: float, r: FrameResult, *, tentative: bool = False) -> None:
        self.frames.append((t, r))
        if tentative:
            self.pending = (t, r)
            return
        self.pending = None
        if r.name_sig is not None:
            self._register(r.name_sig)

    def stable_sigs(self) -> list[NameSig]:
        """至少有另一格與之判為同一人、且夠寬的指紋（連結只信任被 run 內多格印證的指紋，
        單格的殘片偶然相關的機率太高，會把不同敵人連在一起）。"""
        return [s for s, c in zip(self._sigs, self._support) if c >= 1 and s.width >= LINK_MIN_WIDTH]

    def commit_pending(self) -> None:
        """暫列格被新的暫列格取代：視為本 run 內的抖動，併入已確認格。"""
        if self.pending is not None:
            sig = self.pending[1].name_sig
            if sig is not None:
                self._register(sig)
            self.pending = None

    def matches(self, r: FrameResult) -> bool:
        rep = self.representative()
        return rep is None or r.name_sig is None or same_name(rep, r.name_sig, self.threshold)


class EventTracker:
    def __init__(self, profile: Profile, *, resume_start: float | None = None):
        self._threshold = profile.name_sig_threshold
        self._resume_start = resume_start
        self._events: list[Event] = []
        self._run: _Run | None = None
        self._closed: list[_Run] = []  # 已結束且有事件的 run（連結用，只保留視窗內）
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
        if self._run is not None:
            self._close(self._run)
            self._run = None
        return self._events, self._intervals

    # --- 提示橫幅 ---
    def _feed_banner(self, t: float, r: FrameResult) -> None:
        run = self._run
        if r.kind is None:
            return
        if run is not None and t - run.last_t - STEP < GAP - _EPS and run.accepts(r.kind):
            if run.matches(r):
                run.add(t, r)
            else:
                pend = run.pending
                if (pend is not None and t - pend[0] < STEP + _EPS
                        and same_name(pend[1].name_sig, r.name_sig, self._threshold)):
                    if run.stable:
                        self._split(run, pend, t, r)
                        return
                    # 舊 run 從未有過穩定名字（亮／藍背景抖動）：視為同一提示，改採穩定後的名字
                    run.commit_pending()
                    run.add(t, r)
                else:
                    run.commit_pending()
                    run.add(t, r, tentative=True)  # 候選分裂點；先當成本 run 的延續（連續格數照算）
            self._emit(run)
            return
        if run is not None:
            self._close(run)
        suppressed = (self._resume_start is not None
                      and abs(t - self._resume_start) < _EPS)
        self._run = run = _Run(self._threshold, suppressed)
        run.add(t, r)

    def _split(self, old: _Run, pend: tuple[float, FrameResult], t: float, r: FrameResult) -> None:
        """不同名字連續 2 格才分裂；新事件從第一個不同格起算，並把暫列格自舊 run 移出。"""
        old.frames.pop()  # 暫列格一定是最後一格
        old.pending = None
        if old.event is not None and not old.has_pair:
            self._events.remove(old.event)  # 舊 run 少了暫列格後不足連續 2 格：撤回先前發出的事件
            old.event = None
        elif old.event is not None:
            self._emit(old)
        self._close(old)
        new = self._run = _Run(self._threshold, False)
        new.add(pend[0], pend[1])
        new.add(t, r)
        self._emit(new)

    def _close(self, run: _Run) -> None:
        """run 結束：把它的事件連結到視窗內較早的同敵人事件，再記入已結束清單。

        「連結」＝讓這個事件沿用較早事件的 name_sig；derive 以指紋去重，後者就被標為重複。
        逐格指紋在亮／雜背景上會抖動，擊倒與補刀（elim）的代表簽名常對不起來，因此分兩層：
        1. 指紋：兩個 run 各自「被多格印證」的指紋（stable_sigs）有任一對判為同一人（LINK_WINDOW 內，任何計數類型）。
        2. 時間：補刀（elim／assist_elim）接在擊倒（knock／assist_knock）之後 PAIR_WINDOW 秒內，且兩邊沒有
           「都讀得到名字卻不相符」的矛盾時，配對最近一個尚未被配對的擊倒（一次擊倒只被一個補刀吃掉）。
        單格殘片偶然相符的機率太高（實測會把不同敵人連起來），所以第 1 層不使用未被印證的畫格。
        squad_wipe 沒有指紋，不參與。"""
        ev = run.event
        if ev is None:
            return
        self._closed = [c for c in self._closed if run.first_t - c.first_t <= LINK_WINDOW]
        if ev.type in COUNTING_TYPES:
            mine = run.stable_sigs()
            target = None
            for prev in reversed(self._closed):
                if prev.event is None or prev.event.name_sig is None:
                    continue
                if mine and any(same_name(a, b, self._threshold) for a in prev.stable_sigs() for b in mine):
                    target = prev
                    break
            if target is None and ev.type in _FINISH_TYPES:
                for prev in reversed(self._closed):
                    if (prev.event is None or prev.event.name_sig is None or prev.paired
                            or prev.event.type not in _KNOCK_TYPES
                            or run.first_t - prev.first_t > PAIR_WINDOW):
                        continue
                    if self._contradicts(prev, run):
                        continue
                    target = prev
                    break
            if target is not None:
                ev.name_sig = target.event.name_sig
                if ev.type in _FINISH_TYPES and target.event.type in _KNOCK_TYPES:
                    target.paired = True
        self._closed.append(run)

    def _contradicts(self, a: _Run, b: _Run) -> bool:
        """兩個 run 都讀得到名字、寬度相近（差 < 15%）卻沒有任何一對相符 → 不同敵人。
        寬度差很多代表其中一邊多半只是被背景吃掉的殘片，無法反駁。"""
        pairs = [(x, y) for x in a.stable_sigs() for y in b.stable_sigs()
                 if abs(x.width - y.width) / max(x.width, y.width) < 0.15]
        return bool(pairs) and not any(same_name(x, y, self._threshold) for x, y in pairs)

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
