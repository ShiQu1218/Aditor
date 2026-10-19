"""Event tracker that groups per-frame FrameResult values into events, splitting continuous banners, tolerating name jitter, and tracking spectator intervals.

An event is anchored at the first appearance of a banner: consecutive hit frames from the same banner (allowing one empty frame)
form a run; the run's type is determined by majority vote.
There are two reasons to split a run:
1. Name fingerprints (available only on knock banners, using language-independent enemy-name colors): split when the name changes
   and there is an empty frame or score dip between them (a change without either is treated as HUD occlusion/fade jitter).
2. A sustained type change: knocks and assist-knocks share an icon and are distinguished by name color/second-line cues. A type
   change sustained within one run (>= KIND_PERSIST frames on each side) indicates two consecutive banners; brief flickers merge into the adjacent type.
"""
from __future__ import annotations

from bisect import bisect_left

from aditor.detect import fragment_of as fragment_related
from aditor.detect import same_name
from aditor.models import Event, FrameResult, NameSig, SpecInterval
from aditor.profile import Profile

STEP = 0.25
GAP = 0.5          # A banner disappearance (no hit) of >= 0.5 seconds, or two consecutive empty frames, starts a new event.
SPEC_MIN_FRAMES = 8  # Spectating must persist for >= 2 seconds.
_EPS = 1e-6

SPLIT_SCORE_DIP = 0.12   # A score dip this large relative to the run median marks a banner transition.
KIND_PERSIST = 3         # Number of consecutive knock/assist-knock frames needed to split one run into two events.
_MAX_SIGS = 40  # Maximum fingerprints per run for representative-signature calculation (banners last up to ~10s = 40 frames; later frames still match but are not added to the pool).
_P_KINDS = frozenset({"knock", "assist_knock"})


def _family(kind: str | None) -> str | None:
    """Banner family: solo score (knock/assist-knock, same icon) = P; assist elimination (handshake) = H."""
    if kind in _P_KINDS:
        return "P"
    return "H" if kind == "assist_elim" else None


class _Run:
    """Consecutive hits from the same banner; aggregates all hit frames in the run.

    Compare names with the representative signature (the run's medoid/majority), not the previous frame. This prevents
    frame-to-frame fingerprint jitter from treating a single-frame difference as noise that drops the whole run or splits one banner into two events.
    """

    def __init__(self, threshold: float, suppressed: bool):
        self.threshold = threshold
        self.suppressed = suppressed
        self.frames: list[tuple[float, FrameResult]] = []  # All hit frames in this run (including tentative frames).
        self.cont_ts: list[float] = []  # Times of frames with a score chevron but an uncertain person icon (continue the run, but do not count as hits).
        self.event: Event | None = None
        # Latest tentative frame that differs from the representative signature; the next frame must show the same new name to confirm a split.
        self.pending: tuple[float, FrameResult] | None = None
        self.discontinuity = False  # Whether an empty frame (banner fade) appeared after the last frame matching this run's name.
        self.disc_idx: int | None = None  # Index of the first frame after a gap (if confirmed as a new banner, the event starts here).
        self._sigs: list[NameSig] = []   # Fingerprints from confirmed (non-tentative) frames, sorted by timestamp.
        self._support: list[int] = []    # Number of other fingerprints matching the same person for each fingerprint.
        self._counts: dict[str, tuple[int, int]] = {}  # Type -> (frame count, last occurrence index).
        self._score = 0.0
        self._damage = False
        self._times: list[float] = []  # Banner timestamps sorted by time before confirming two consecutive frames.
        self._has_pair = False

    # --- Aggregation ---
    @property
    def family(self) -> str | None:
        return _family(self.frames[0][1].kind)

    @property
    def kind(self) -> str | None:
        """Run type by majority vote across frame types (ties go to the later type). Icon cues are unreliable during fade-in, so majority vote stabilizes the run."""
        return max(self._counts, key=self._counts.__getitem__)

    @property
    def first_t(self) -> float:
        return self.frames[0][0]

    @property
    def last_t(self) -> float:
        return self.frames[-1][0]

    @property
    def reach_t(self) -> float:
        """Timestamp of the last frame with banner evidence (including cont frames), used to determine continuity."""
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
        """Whether any two confirmed-frame fingerprints match the same person (otherwise fingerprints are unreliable and must not trigger a split)."""
        return any(c >= 1 for c in self._support)

    # --- Representative signature ---
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
        """Medoid: the fingerprint matching the most other fingerprints as the same person (majority); break ties by choosing the earliest.
        For a clean run where all fingerprints match, this returns the first fingerprint."""
        if not self._sigs:
            return None
        best = max(range(len(self._sigs)), key=lambda i: (self._support[i], -i))
        return self._sigs[best]

    def reset(self, frames: list[tuple[float, FrameResult]], cont_ts: list[float] | None = None) -> None:
        """Rebuild this run's aggregate state from the supplied frames (the second half is moved to a new run when splitting)."""
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

    # --- Updates ---
    def _add_time(self, t: float) -> None:
        if self._has_pair:
            return
        # On reset, replay hit frames and cont frames separately; inserting at adjacent positions confirms whether two consecutive frames exist.
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
        """A new tentative frame replaced the prior one: treat it as jitter within this run and merge it into confirmed frames."""
        if self.pending is not None:
            sig = self.pending[1].name_sig
            if sig is not None:
                self._register(sig)
            self.pending = None

    def kind_cut(self) -> int | None:
        """Return the frame index where a sustained type change begins, or None.

        In family P, each frame is either a knock (true) or assist-knock (false). A run of the same value is stable when it has
        >= KIND_PERSIST frames (shorter runs are flickers merged into surrounding runs); split at the first frame of adjacent stable runs with different values."""
        if self.family != "P":
            return None
        segs: list[list] = []  # [value, first frame index, frame count]
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
        """Compare only with the representative signature: same name or fragment relationship; a missing name or signature is not a conflict."""
        rep = self.representative()
        if r.name_sig is None or rep is None:
            return True
        return same_name(rep, r.name_sig, self.threshold) or fragment_related(rep, r.name_sig)

    def matches(self, r: FrameResult) -> bool:
        """Whether this frame's name belongs to the run: it must match the representative signature or any confirmed-frame signature (a missing name is not a conflict)."""
        if r.name_sig is None or not self._sigs:
            return True
        if any(same_name(o, r.name_sig, self.threshold) for o in [self.representative(), *self._sigs]):
            return True
        # A narrower fragment caused by HUD occlusion/fade is still the same name; it is not a conflict and belongs in this run.
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
        """Return copies of current events and spectating intervals without ending the stream; include in-progress spectating intervals that have reached 2 seconds."""
        events = [Event.from_dict(e.to_dict()) for e in self._events]
        intervals = [SpecInterval(i.start, i.end) for i in self._intervals]
        if self._spec_first is not None and self._spec_n >= SPEC_MIN_FRAMES:
            intervals.append(SpecInterval(self._spec_first, self._spec_last + STEP))
        return events, intervals

    def finish(self) -> tuple[list[Event], list[SpecInterval]]:
        self._flush_spec()
        self._run = None
        return self._events, self._intervals

    # --- Banner events ---
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
            # After an empty frame (banner transition), compare the first new frame only with the run's representative signature
            # or its fragment: noisy fingerprints caused by occlusion/fire within a run must not absorb another enemy's banner
            # (two back-to-back enemies in acceptance clip test-ENG).
            gap = t - run.reach_t > STEP + _EPS
            if gap and not run.discontinuity:
                run.discontinuity, run.disc_idx = True, len(run.frames)
            rep_before = run.representative()
            if (run.matches_representative(r) if run.discontinuity else run.matches(r)):
                run.add(t, r)
                # After a gap, confirm the same banner only when a frame has a readable name matching the representative signature.
                # Names on a new banner often take several frames to become readable, so keep unreadable frames tentative.
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
                        # A name change with no discontinuity (no empty frame or score dip) is jitter caused by HUD occlusion/fade.
                        # The game shows only one centered banner at a time; switching to another enemy's banner must include a fade (gap) or score dip.
                        run.commit_pending()
                        run.add(t, r)
                        self._emit(run)
                        return
                    # The old run never had a stable name (bright/blue-background jitter): treat this as the same banner and adopt the newly stable name.
                    run.commit_pending()
                    run.add(t, r)
                else:
                    run.commit_pending()
                    run.add(t, r, tentative=True)  # Candidate split point; initially continue this run (still count consecutive frames).
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
        """Whether there is a discontinuity between the old run and the new name: an empty frame after the old name's last occurrence, or a clear icon-score dip."""
        if run.discontinuity:
            return True
        base = sorted(f.score for _, f in run.frames[:-1])
        if not base:
            return False
        ref = base[len(base) // 2]
        return min(pend[1].score, r.score) < ref - SPLIT_SCORE_DIP

    def _move_tail(self, old: _Run, idx: int) -> _Run:
        """Move old.frames[idx:] to a new run (old retains the first half); retract or update the old event based on its remaining frames. Return the new run, now set as current."""
        moved = old.frames[idx:]
        cont = list(old.cont_ts)
        old.reset(old.frames[:idx], cont)
        if old.event is not None and not old.has_pair:
            self._events.remove(old.event)  # The old run now has fewer than two consecutive frames, so retract the previously emitted event.
            old.event = None
        elif old.event is not None:
            self._emit(old)
        new = self._run = _Run(self._threshold, False)
        new.reset(moved, cont)
        return new

    def _split(self, old: _Run, pend: tuple[float, FrameResult], t: float, r: FrameResult) -> None:
        """Split only after two consecutive frames show a different name.

        Normally the new event starts at the first differing frame (the tentative frame). If there is a gap after the old
        run's last name (banner transition), start the new event at the first frame after the gap; the new banner's name often
        takes several frames to become readable, and those frames do not belong to the old banner."""
        idx = old.disc_idx if (old.discontinuity and old.disc_idx is not None) else len(old.frames) - 1
        idx = min(idx, len(old.frames) - 1)
        new = self._move_tail(old, idx)
        new.add(t, r)
        self._emit(new)

    def _cut_kind(self, old: _Run, idx: int) -> None:
        """For a sustained type change, split into a new event at the first frame of the new stable type."""
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

    # --- Spectating ---
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
