use crate::{
    detect::{fragment_of, same_name},
    models::{Event, FrameResult, NameSig, SpecInterval},
    profile::Profile,
};
use std::collections::BTreeMap;
pub const STEP: f64 = 0.25;
const EPS: f64 = 1e-6;
fn family(kind: Option<&str>) -> Option<char> {
    match kind {
        Some("knock" | "assist_knock") => Some('P'),
        Some("kill") => Some('K'),
        Some("assist_elim") => Some('H'),
        _ => None,
    }
}
struct Run {
    threshold: f64,
    suppressed: bool,
    frames: Vec<(f64, FrameResult)>,
    cont: Vec<f64>,
    event: Option<usize>,
    pending: Option<(f64, FrameResult)>,
    discontinuity: bool,
    disc_idx: Option<usize>,
    sigs: Vec<NameSig>,
    support: Vec<usize>,
    counts: BTreeMap<String, (usize, usize)>,
    score: f64,
    damage: bool,
    times: Vec<f64>,
    pair: bool,
}
impl Run {
    fn new(threshold: f64, suppressed: bool) -> Self {
        Self {
            threshold,
            suppressed,
            frames: vec![],
            cont: vec![],
            event: None,
            pending: None,
            discontinuity: false,
            disc_idx: None,
            sigs: vec![],
            support: vec![],
            counts: BTreeMap::new(),
            score: 0.,
            damage: false,
            times: vec![],
            pair: false,
        }
    }
    fn family(&self) -> Option<char> {
        family(self.frames[0].1.kind.as_deref())
    }
    fn kind(&self) -> String {
        self.counts
            .iter()
            .max_by_key(|(_, v)| **v)
            .unwrap()
            .0
            .clone()
    }
    fn reach(&self) -> f64 {
        self.cont
            .iter()
            .copied()
            .fold(self.frames.last().unwrap().0, f64::max)
    }
    fn representative(&self) -> Option<&NameSig> {
        self.support
            .iter()
            .enumerate()
            .max_by_key(|(i, c)| (**c, std::cmp::Reverse(*i)))
            .map(|(i, _)| &self.sigs[i])
    }
    fn register(&mut self, sig: NameSig) {
        if self.sigs.len() >= 40 {
            return;
        }
        let mut count = 0;
        for (i, s) in self.sigs.iter().enumerate() {
            if same_name(Some(s), Some(&sig), self.threshold) {
                self.support[i] += 1;
                count += 1;
            }
        }
        self.sigs.push(sig);
        self.support.push(count);
    }
    fn add_time(&mut self, t: f64) {
        if self.pair {
            return;
        }
        let i = self.times.partition_point(|&v| v < t);
        self.pair = i > 0 && t - self.times[i - 1] < STEP + EPS
            || i < self.times.len() && self.times[i] - t < STEP + EPS;
        self.times.insert(i, t);
    }
    fn add_cont(&mut self, t: f64) {
        self.cont.push(t);
        self.add_time(t);
    }
    fn add(&mut self, t: f64, r: FrameResult, tentative: bool) {
        let i = self.frames.len();
        let c = self.counts.entry(r.kind.clone().unwrap()).or_default();
        *c = (c.0 + 1, i);
        self.score = if i == 0 {
            r.score
        } else {
            self.score.max(r.score)
        };
        self.damage |= r.damage_line;
        self.add_time(t);
        self.frames.push((t, r.clone()));
        if tentative {
            self.pending = Some((t, r));
        } else {
            self.pending = None;
            if let Some(s) = r.name_sig {
                self.register(s);
            }
        }
    }
    fn commit(&mut self) {
        if let Some((_, r)) = self.pending.take() {
            if let Some(s) = r.name_sig {
                self.register(s);
            }
        }
    }
    fn reset(&mut self, frames: Vec<(f64, FrameResult)>, cont: &[f64]) {
        let event = self.event;
        *self = Self::new(self.threshold, self.suppressed);
        self.event = event;
        for (t, r) in frames {
            self.add(t, r, false);
        }
        for &t in cont {
            if !self.frames.is_empty() && t >= self.frames[0].0 {
                self.add_cont(t);
            }
        }
    }
    fn matches_rep(&self, r: &FrameResult) -> bool {
        r.name_sig.is_none()
            || self.representative().is_none()
            || same_name(self.representative(), r.name_sig.as_ref(), self.threshold)
            || fragment_of(self.representative(), r.name_sig.as_ref())
    }
    fn matches(&self, r: &FrameResult) -> bool {
        r.name_sig.is_none()
            || self.sigs.is_empty()
            || self.sigs.iter().any(|s| {
                same_name(Some(s), r.name_sig.as_ref(), self.threshold)
                    || fragment_of(Some(s), r.name_sig.as_ref())
            })
    }
    fn kind_cut(&self) -> Option<usize> {
        if self.family() != Some('P') {
            return None;
        }
        let mut segs: Vec<(bool, usize, usize)> = vec![];
        for (i, (_, r)) in self.frames.iter().enumerate() {
            let v = r.kind.as_deref() == Some("knock");
            if let Some(s) = segs.last_mut().filter(|s| s.0 == v) {
                s.2 += 1;
            } else {
                segs.push((v, i, 1));
            }
        }
        let mut prev = None;
        for (v, first, n) in segs {
            if n < 3 {
                continue;
            }
            if prev.is_some_and(|p| p != v) {
                return Some(first);
            }
            prev = Some(v);
        }
        None
    }
    fn is_break(&self, pend: &(f64, FrameResult), r: &FrameResult) -> bool {
        if self.discontinuity {
            return true;
        }
        if r.hint.as_deref() == Some("plain")
            && pend.1.hint == r.hint
            && self.frames[0].1.hint == r.hint
        {
            return self.frames[..self.frames.len() - 1].windows(2).any(|w| {
                w[1].0 - w[0].0 <= STEP + EPS
                    && same_name(
                        w[0].1.name_sig.as_ref(),
                        w[1].1.name_sig.as_ref(),
                        self.threshold,
                    )
            });
        }
        let mut scores: Vec<_> = self.frames[..self.frames.len() - 1]
            .iter()
            .map(|(_, r)| r.score)
            .collect();
        scores.sort_by(f64::total_cmp);
        !scores.is_empty() && pend.1.score.min(r.score) < scores[scores.len() / 2] - 0.12
    }
}
pub struct EventTracker {
    threshold: f64,
    resume_start: Option<f64>,
    events: Vec<Option<Event>>,
    run: Option<Run>,
    spec_first: Option<f64>,
    spec_last: f64,
    spec_n: usize,
    intervals: Vec<SpecInterval>,
}
impl EventTracker {
    pub fn new(profile: &Profile, resume_start: Option<f64>) -> Self {
        Self {
            threshold: profile.name_sig_threshold,
            resume_start,
            events: vec![],
            run: None,
            spec_first: None,
            spec_last: 0.,
            spec_n: 0,
            intervals: vec![],
        }
    }
    fn emit(&mut self, run: &mut Run) {
        if !run.pair || run.suppressed {
            return;
        }
        let kind = run.kind();
        let i = *run.event.get_or_insert_with(|| {
            let i = self.events.len();
            self.events.push(Some(Event {
                id: format!("a{}", (run.frames[0].0 * 1000.).round_ties_even() as i64),
                t: run.frames[0].0,
                kind: kind.clone(),
                score: run.score,
                damage_line: run.damage,
                name_sig: None,
                counted: false,
                counted_reason: String::new(),
                counted_override: None,
                source: "auto".into(),
                deleted: false,
            }));
            i
        });
        let e = self.events[i].as_mut().unwrap();
        e.kind = kind.clone();
        e.score = run.score;
        e.damage_line = run.damage;
        if kind != "kill" && kind != "assist_elim" {
            if let Some(s) = run.representative() {
                e.name_sig = Some(s.to_b64().into());
            }
        }
    }
    fn move_tail(&mut self, mut old: Run, idx: usize) -> Run {
        let tail = old.frames.split_off(idx);
        let cont = old.cont.clone();
        let frames = std::mem::take(&mut old.frames);
        old.reset(frames, &cont);
        if !old.pair {
            if let Some(i) = old.event.take() {
                self.events[i] = None;
            }
        } else if old.event.is_some() {
            self.emit(&mut old);
        }
        let mut new = Run::new(self.threshold, false);
        new.reset(tail, &cont);
        new
    }
    pub fn feed(&mut self, t: f64, r: FrameResult) {
        if r.spectating {
            if self.spec_first.is_none() {
                self.spec_first = Some(t);
                self.spec_n = 0;
            }
            self.spec_n += 1;
            self.spec_last = t;
        } else {
            self.flush_spec();
        }
        let Some(mut run) = self.run.take() else {
            if r.kind.is_some() {
                let mut run = Run::new(
                    self.threshold,
                    self.resume_start.is_some_and(|s| (s - t).abs() < EPS),
                );
                run.add(t, r, false);
                self.run = Some(run);
            }
            return;
        };
        if r.kind.is_none() {
            let continuation = r.hint.as_deref() == Some("cont") && run.family() == Some('P')
                || r.hint.as_deref() == Some("plain_cont")
                    && matches!(run.family(), Some('K' | 'H'));
            if continuation && t - run.reach() - STEP < 0.5 - EPS {
                run.add_cont(t);
                self.emit(&mut run);
            }
            self.run = Some(run);
            return;
        }
        if t - run.reach() - STEP >= 0.5 - EPS || run.family() != family(r.kind.as_deref()) {
            run = Run::new(
                self.threshold,
                self.resume_start.is_some_and(|s| (s - t).abs() < EPS),
            );
            run.add(t, r, false);
            self.run = Some(run);
            return;
        }
        if t - run.reach() > STEP + EPS && !run.discontinuity {
            run.discontinuity = true;
            run.disc_idx = Some(run.frames.len());
        }
        let no_rep = run.representative().is_none();
        if if run.discontinuity {
            run.matches_rep(&r)
        } else {
            run.matches(&r)
        } {
            run.add(t, r.clone(), false);
            if r.name_sig.is_some() && (no_rep || run.matches_rep(&r)) {
                run.discontinuity = false;
                run.disc_idx = None;
            }
        } else if run.pending.as_ref().is_some_and(|p| {
            t - p.0 < STEP + EPS
                && same_name(p.1.name_sig.as_ref(), r.name_sig.as_ref(), self.threshold)
        }) {
            if run.support.iter().any(|&c| c >= 1) {
                if run.is_break(run.pending.as_ref().unwrap(), &r) {
                    let idx = if run.discontinuity {
                        run.disc_idx.unwrap_or(run.frames.len() - 1)
                    } else {
                        run.frames.len() - 1
                    };
                    run = self.move_tail(run, idx);
                    run.add(t, r, false);
                    self.emit(&mut run);
                    self.run = Some(run);
                    return;
                }
                run.commit();
                run.add(t, r, false);
                self.emit(&mut run);
                self.run = Some(run);
                return;
            }
            run.commit();
            run.add(t, r, false);
        } else {
            run.commit();
            run.add(t, r, true);
        }
        if let Some(cut) = run.kind_cut() {
            run = self.move_tail(run, cut);
        }
        self.emit(&mut run);
        self.run = Some(run);
    }
    pub fn snapshot(&self) -> (Vec<Event>, Vec<SpecInterval>) {
        let mut intervals = self.intervals.clone();
        if let Some(start) = self.spec_first.filter(|_| self.spec_n >= 8) {
            intervals.push(SpecInterval {
                start,
                end: self.spec_last + STEP,
            });
        }
        (self.events.iter().flatten().cloned().collect(), intervals)
    }
    fn flush_spec(&mut self) {
        if let Some(start) = self.spec_first.take().filter(|_| self.spec_n >= 8) {
            self.intervals.push(SpecInterval {
                start,
                end: self.spec_last + STEP,
            });
        }
        self.spec_n = 0;
    }
    pub fn finish(mut self) -> (Vec<Event>, Vec<SpecInterval>) {
        self.flush_spec();
        self.run = None;
        self.snapshot()
    }
}
