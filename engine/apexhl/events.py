from __future__ import annotations

from apexhl.detect import same_name
from apexhl.models import Event, FrameResult, NameSig, SpecInterval
from apexhl.profile import Profile

STEP = 0.25
GAP = 0.5          # 提示消失（無命中）≥ 0.5 秒 = 連續 2 格空白才算新事件
SPEC_MIN_FRAMES = 8  # 觀戰連續 ≥ 2 秒
_EPS = 1e-6


class _Run:
    """同一個提示（kind + 名字）的連續命中。"""

    def __init__(self, t: float, r: FrameResult, suppressed: bool):
        self.kind = r.kind
        self.last_t = t
        self.streak_start = t
        self.streak = 1
        self.last_sig: NameSig | None = r.name_sig
        self.suppressed = suppressed
        self.event: Event | None = None


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

    def finish(self) -> tuple[list[Event], list[SpecInterval]]:
        self._flush_spec()
        return self._events, self._intervals

    # --- 提示橫幅 ---
    def _feed_banner(self, t: float, r: FrameResult) -> None:
        run = self._run
        if r.kind is None:
            return
        if run is not None and t - run.last_t - STEP < GAP - _EPS and self._continues(run, r):
            if t - run.last_t < STEP + _EPS:
                run.streak += 1
            else:
                run.streak, run.streak_start = 1, t
            run.last_t = t
            if r.name_sig is not None:
                run.last_sig = r.name_sig
            if run.event is not None:
                self._update(run.event, r)
            elif run.streak >= 2 and not run.suppressed:
                run.event = self._make(run.streak_start, r)
                self._events.append(run.event)
            return
        suppressed = (self._resume_start is not None
                      and abs(t - self._resume_start) < _EPS)
        self._run = _Run(t, r, suppressed)

    def _continues(self, run: _Run, r: FrameResult) -> bool:
        if r.kind != run.kind:
            return False
        if run.last_sig is not None and r.name_sig is not None:
            return same_name(run.last_sig, r.name_sig, self._threshold)
        return True

    @staticmethod
    def _make(t: float, r: FrameResult) -> Event:
        return Event(id=f"a{int(round(t * 1000))}", t=t, type=r.kind, score=r.score,
                     damage_line=r.damage_line,
                     name_sig=r.name_sig.to_b64() if r.name_sig is not None else None)

    @staticmethod
    def _update(ev: Event, r: FrameResult) -> None:
        ev.score = max(ev.score, r.score)
        ev.damage_line = ev.damage_line or r.damage_line
        if ev.name_sig is None and r.name_sig is not None:
            ev.name_sig = r.name_sig.to_b64()

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
