from __future__ import annotations

import hashlib

import numpy as np

from apexhl.detect import fragment_of as fragment_related
from apexhl.detect import related_name, same_name
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
SPLIT_SCORE_DIP = 0.12   # 關鍵字分數凹陷（相對於 run 內的中位數）達這麼多，視為橫幅被換掉的不連續點
ASSIST_MIX_WINDOW = 1.0  # 助攻橫幅淡入的前幾格，子關鍵字（擊倒／消滅）常讀不準：run 開始後這麼多秒內互相接納
_MAX_SIGS = 40  # 每個 run 最多納入代表簽名計算的指紋數（橫幅最長約 10 秒 = 40 格；超過者仍參與比對但不入池）


def _pseudo_sig(seed_text: str) -> NameSig:
    """決定性的偽名字指紋（高 16、寬 40 的隨機位元），僅用於「讀不到名字」的擊倒與其補刀的配對。"""
    seed = int.from_bytes(hashlib.sha256(seed_text.encode()).digest()[:8], "big")
    rng = np.random.default_rng(seed)
    return NameSig(40, (rng.random((NameSig.HEIGHT, 40)) > 0.5).astype(np.uint8))


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
        self.discontinuity = False  # 最後一個「與本 run 名字相符」的畫格之後，是否出現過空白格（橫幅淡出）
        self.disc_idx: int | None = None  # 空白格之後第一格在 frames 的索引（若之後確認是新橫幅，新事件從這格起算）
        self._sigs: list[NameSig] = []   # 已確認（非暫列）格的指紋，依時間排序
        self._support: list[int] = []    # 與各指紋「同一人」的其他指紋數
        self._fb_sigs: list[NameSig] = []      # 備援指紋（白字名，I3）：整個 run 沒有紅字名時才採用
        self._fb_support: list[int] = []

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

    def accepts(self, kind: str | None, t: float) -> bool:
        """這個 run 能不能接納該類型的畫格：同類型；或同屬助攻家族（assist_knock／assist_elim）且
        連續（沒有空白格）或仍在淡入期（run 開始後 ASSIST_MIX_WINDOW 秒內）。

        橫幅淡入時子關鍵字讀不準，所以淡入期與連續畫格允許互收；但「助攻，擊倒 X」之後隔一格空白、
        換成「助攻，消滅 X」是同一敵人的另一則橫幅（I2），不得併成一個 run（否則少一個補刀事件、類型錯誤）。"""
        k = self.kind
        if kind == k:
            return True
        if kind in _ASSIST_KINDS and k in _ASSIST_KINDS:
            return t - self.last_t < STEP + _EPS or t - self.first_t < ASSIST_MIX_WINDOW
        return False

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
        self._append(self._sigs, self._support, sig)

    def _append(self, sigs: list[NameSig], support: list[int], sig: NameSig) -> None:
        if len(sigs) >= _MAX_SIGS:
            return
        sup = 0
        for i, o in enumerate(sigs):
            if same_name(o, sig, self.threshold):
                support[i] += 1
                sup += 1
        sigs.append(sig)
        support.append(sup)

    def _pool(self) -> tuple[list[NameSig], list[int]]:
        """連結／代表簽名採用的指紋池：有被印證的紅字名就只用紅字名，否則退回白字備援指紋（再次擊倒，I3）。"""
        # 紅字名指紋只有零星幾格、彼此也無法印證（例如「再次擊倒」白字名旁邊偶然取到的雜點）時，白字備援更可靠
        if self._sigs and (any(c >= 1 for c in self._support) or not self._fb_sigs):
            return self._sigs, self._support
        return self._fb_sigs, self._fb_support

    def representative(self) -> NameSig | None:
        """medoid：與最多其他指紋判為同一人的指紋（多數）；同分取最早的。
        乾淨的 run（全部互為同一人）因此回傳第一個指紋，與逐格追蹤的舊行為相同。"""
        sigs, support = self._pool()
        if not sigs:
            return None
        best = max(range(len(sigs)), key=lambda i: (support[i], -i))
        return sigs[best]

    def reset(self, frames: list[tuple[float, FrameResult]]) -> None:
        """以給定畫格重建本 run 的彙整狀態（分裂時把後半段移給新 run）。"""
        self.frames, self.pending = [], None
        self._sigs, self._support, self._fb_sigs, self._fb_support = [], [], [], []
        self.discontinuity, self.disc_idx = False, None
        for t, r in frames:
            self.add(t, r)

    # --- 變更 ---
    def add(self, t: float, r: FrameResult, *, tentative: bool = False) -> None:
        self.frames.append((t, r))
        if tentative:
            self.pending = (t, r)
            return
        self.pending = None
        if r.name_sig is not None:
            self._register(r.name_sig)
        elif r.alt_sig is not None:
            self._append(self._fb_sigs, self._fb_support, r.alt_sig)

    def stable_sigs(self) -> list[NameSig]:
        """至少有另一格與之判為同一人、且夠寬的指紋（連結只信任被 run 內多格印證的指紋，
        單格的殘片偶然相關的機率太高，會把不同敵人連在一起）。"""
        sigs, support = self._pool()
        return [s for s, c in zip(sigs, support) if c >= 1 and s.width >= LINK_MIN_WIDTH]

    def commit_pending(self) -> None:
        """暫列格被新的暫列格取代：視為本 run 內的抖動，併入已確認格。"""
        if self.pending is not None:
            sig = self.pending[1].name_sig
            if sig is not None:
                self._register(sig)
            self.pending = None

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
        # 被 HUD 遮擋／淡出而變窄的殘片仍是同一個名字（I1）：不算矛盾，併入本 run
        return any(fragment_related(o, r.name_sig) for o in self._sigs)


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
        if run is not None and t - run.last_t - STEP < GAP - _EPS and run.accepts(r.kind, t):
            # 空白格（橫幅「彈出」換場）之後的第一格只和 run 的代表簽名（或其殘片）比對：run 內遮擋／火光造成的
            # 雜訊指紋不能把另一個敵人的新橫幅吸收進來（驗收片 test-ENG 背靠背兩個敵人）
            gap = t - run.last_t > STEP + _EPS
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
                        # 沒有任何不連續（無空白格、分數沒凹陷）的名字改變 = HUD 遮擋／淡出造成的抖動（I1）：
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
            self._emit(run)
            return
        if run is not None:
            self._close(run)
        suppressed = (self._resume_start is not None
                      and abs(t - self._resume_start) < _EPS)
        self._run = run = _Run(self._threshold, suppressed)
        run.add(t, r)

    @staticmethod
    def _is_break(run: _Run, pend: tuple[float, FrameResult], r: FrameResult) -> bool:
        """舊 run 與「新名字」之間有沒有不連續：舊名字最後出現之後有空白格，或關鍵字分數明顯凹陷。"""
        if run.discontinuity:
            return True
        base = sorted(f.score for _, f in run.frames[:-1])
        if not base:
            return False
        ref = base[len(base) // 2]
        return min(pend[1].score, r.score) < ref - SPLIT_SCORE_DIP

    def _split(self, old: _Run, pend: tuple[float, FrameResult], t: float, r: FrameResult) -> None:
        """不同名字連續 2 格才分裂。

        一般情況新事件從第一個不同格（暫列格）起算；若舊 run 的名字最後出現後有空白格（橫幅換場），
        新事件從空白格之後的第一格起算（新橫幅的名字常要幾格才讀得到，這些格不屬於舊橫幅）。"""
        idx = old.disc_idx if (old.discontinuity and old.disc_idx is not None) else len(old.frames) - 1
        idx = min(idx, len(old.frames) - 1)
        moved = old.frames[idx:]
        old.reset(old.frames[:idx])
        if old.event is not None and not old.has_pair:
            self._events.remove(old.event)  # 舊 run 少了這些格後不足連續 2 格：撤回先前發出的事件
            old.event = None
        elif old.event is not None:
            self._emit(old)
        self._close(old)
        new = self._run = _Run(self._threshold, False)
        for mt, mr in moved:
            new.add(mt, mr)
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
                    if (prev.event is None or prev.paired
                            or prev.event.type not in _KNOCK_TYPES
                            or run.first_t - prev.first_t > PAIR_WINDOW):
                        continue
                    if self._contradicts(prev, run):
                        continue
                    if prev.event.name_sig is None and run.stable_sigs():
                        continue  # 擊倒讀不到名字、補刀卻有可靠名字：無法證明是同一人，保守不配對
                    target = prev
                    break
            if target is not None:
                if target.event.name_sig is None:
                    # 擊倒完全讀不到名字（例如白字名也取不到）：配對成立時兩者共用一個由擊倒 id 決定的
                    # 偽指紋，derive 才能把補刀標為重複；偽指紋與任何真實名字或其他偽指紋都不相關
                    target.event.name_sig = _pseudo_sig(target.event.id).to_b64()
                ev.name_sig = target.event.name_sig
                if ev.type in _FINISH_TYPES and target.event.type in _KNOCK_TYPES:
                    target.paired = True
        self._closed.append(run)

    def _contradicts(self, a: _Run, b: _Run) -> bool:
        """兩個 run 都有被多格印證、夠寬的名字，卻沒有任何一對「同名或互為殘片」→ 不同敵人（I4）。
        殘片關係用滑動相關判斷（較短者能在較長者上找到對應位置），不再只看寬度：
        寬度差很大但內容無關的兩個名字是不同的人；真正被遮擋的殘片則找得到對應位置。"""
        xs, ys = a.stable_sigs(), b.stable_sigs()
        if not xs or not ys:
            return False
        return not any(related_name(x, y, self._threshold) for x in xs for y in ys)

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
