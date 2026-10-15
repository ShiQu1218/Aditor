from __future__ import annotations

from apexhl.detect import same_name
from apexhl.models import Event, FrameResult, NameSig, SpecInterval
from apexhl.profile import Profile

STEP = 0.25
GAP = 0.5          # 提示消失（無命中）≥ 0.5 秒 = 連續 2 格空白才算新事件
SPEC_MIN_FRAMES = 8  # 觀戰連續 ≥ 2 秒
_EPS = 1e-6


class _Run:
    """同一個提示（kind + 名字）的連續命中；彙整整段 run 的所有命中格。"""

    def __init__(self, t: float, r: FrameResult, suppressed: bool):
        self.kind = r.kind
        self.first_t = t
        self.last_t = t
        self.streak = 1  # 目前連續命中格數
        self.has_pair = False  # 是否出現過連續 2 格
        self.last_sig: NameSig | None = r.name_sig
        self.first_sig: NameSig | None = r.name_sig
        self.score = r.score
        self.damage = r.damage_line
        self.suppressed = suppressed
        self.event: Event | None = None
        self.pending: tuple[float, FrameResult] | None = None  # 名字不同的候選分裂起點（需連續 2 格）
        self.last_sig_t = t  # 最近一次採納簽名的時間
        self.stable = False  # 是否出現過兩格名字相同（否則指紋不可靠，不據以分裂）

    def add(self, t: float, r: FrameResult) -> None:
        self.streak = self.streak + 1 if t - self.last_t < STEP + _EPS else 1
        self.has_pair = self.has_pair or self.streak >= 2
        self.last_t = t
        self.score = max(self.score, r.score)
        self.damage = self.damage or r.damage_line
        if r.name_sig is not None:
            self.last_sig = r.name_sig
            self.last_sig_t = t
            if self.first_sig is None:
                self.first_sig = r.name_sig


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
        return self._events, self._intervals

    # --- 提示橫幅 ---
    def _feed_banner(self, t: float, r: FrameResult) -> None:
        run = self._run
        if r.kind is None:
            return
        if run is not None and t - run.last_t - STEP < GAP - _EPS and r.kind == run.kind:
            if self._other_name(run, r):
                pend = run.pending
                if (pend is not None and t - pend[0] < STEP + _EPS
                        and same_name(pend[1].name_sig, r.name_sig, self._threshold)):
                    if not run.stable:
                        # 舊 run 從未有過穩定名字（亮／藍背景抖動）：視為同一提示，改採穩定後的名字
                        run.first_sig = run.last_sig = pend[1].name_sig
                        run.stable = True
                        run.pending = None
                        run.add(t, r)
                    else:
                        # 不同名字連續 2 格才分裂；新事件從第一個不同格起算
                        run = self._run = _Run(pend[0], pend[1], False)
                        run.add(t, r)
                        run.stable = True
                    self._emit(run)
                else:
                    run.pending = (t, r)  # 候選分裂點；此格暫視為舊 run 的延續（不更新簽名）
                    run.last_t = t
                return
            run.pending = None
            if (run.last_sig is not None and r.name_sig is not None
                    and t - run.last_sig_t < STEP + _EPS):
                run.stable = True  # 連續 2 格名字相同
            run.add(t, r)
            self._emit(run)
            return
        suppressed = (self._resume_start is not None
                      and abs(t - self._resume_start) < _EPS)
        self._run = _Run(t, r, suppressed)

    def _other_name(self, run: _Run, r: FrameResult) -> bool:
        return (run.last_sig is not None and r.name_sig is not None
                and not same_name(run.last_sig, r.name_sig, self._threshold))

    def _emit(self, run: _Run) -> None:
        if run.has_pair and not run.suppressed:
            if run.event is None:
                run.event = Event(id=f"a{int(round(run.first_t * 1000))}", t=run.first_t,
                                  type=run.kind, score=run.score,
                                  damage_line=run.damage, name_sig=None)
                self._events.append(run.event)
            run.event.score = run.score
            run.event.damage_line = run.damage
            if run.first_sig is not None:
                run.event.name_sig = run.first_sig.to_b64()

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
