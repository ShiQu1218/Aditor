use super::{clip_intervals, merge_intervals, save, AnalyzeOptions, Document, Segment};
use crate::{
    calibrate::{
        self, build_keywords, extend_keywords, keywords_complete, same_keywords, AnchorCollector,
    },
    decode::{DecodeOptions, FrameStream},
    detect::{Detector, Keywords, Prepared},
    events::EventTracker,
    models::{Event, SpecInterval},
    profile::Profile,
};
use anyhow::Result;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;

pub(super) struct Learning {
    spans: Vec<(f64, f64)>,
    late_spans: Vec<(f64, f64)>,
    cols: Vec<AnchorCollector>,
    late_cols: Vec<AnchorCollector>,
    waiting: Vec<bool>,
    keywords: Option<Keywords>,
    final_kw: Option<Keywords>,
}
impl Learning {
    pub fn new(segs: &[Segment], duration: f64) -> Self {
        let limit = duration.min(calibrate::LEARN_SCAN_SECONDS);
        let spans: Vec<_> = segs
            .iter()
            .map(|s| (s.start, if s.last { limit } else { s.end.min(limit) }))
            .collect();
        let late_spans = segs
            .iter()
            .map(|s| (s.start.max(limit), if s.last { duration } else { s.end }))
            .collect();
        let waiting = spans.iter().map(|&(a, b)| b > a).collect();
        let mut l = Self {
            spans,
            late_spans,
            cols: vec![AnchorCollector::default(); segs.len()],
            late_cols: vec![AnchorCollector::default(); segs.len()],
            waiting,
            keywords: None,
            final_kw: None,
        };
        if !l.waiting.iter().any(|&w| w) {
            l.keywords = Some(Keywords::default());
        }
        l
    }
    fn late(&self) -> bool {
        self.keywords.is_some()
            && !keywords_complete(self.keywords.as_ref())
            && self.late_spans.iter().any(|&(a, b)| b > a)
    }
    fn finish(&mut self, i: usize) -> Result<()> {
        if !self.waiting[i] {
            return Ok(());
        }
        self.waiting[i] = false;
        if !self.waiting.iter().any(|&w| w) {
            self.keywords = Some(build_keywords(&self.cols)?);
        }
        Ok(())
    }
}
pub(super) struct State {
    pub segs: Vec<Segment>,
    kept_events: Vec<Event>,
    kept_spec: Vec<SpecInterval>,
    keywords: Option<Keywords>,
    learning: Option<Learning>,
    replays: Vec<Option<Vec<(f64, Prepared)>>>,
    last_emit: Option<Instant>,
}
impl State {
    pub fn new(
        segs: Vec<Segment>,
        kept_events: Vec<Event>,
        kept_spec: Vec<SpecInterval>,
        keywords: Option<Keywords>,
        learning: Option<Learning>,
    ) -> Self {
        let replays = vec![None; segs.len()];
        Self {
            segs,
            kept_events,
            kept_spec,
            keywords,
            learning,
            replays,
            last_emit: None,
        }
    }
    pub fn learned(&self) -> Option<&Keywords> {
        match &self.learning {
            None => self.keywords.as_ref(),
            Some(l) => {
                l.final_kw
                    .as_ref()
                    .or_else(|| if l.late() { None } else { l.keywords.as_ref() })
            }
        }
    }
    pub fn combined(&self) -> (Vec<Event>, Vec<SpecInterval>) {
        let mut evs = self.kept_events.clone();
        let mut spec = self.kept_spec.clone();
        for s in &self.segs {
            evs.extend(s.events.clone());
            evs.extend(s.feed_events.clone());
            spec.extend(s.spec.clone());
        }
        evs.sort_by(|a, b| a.t.total_cmp(&b.t));
        (evs, merge_intervals(spec))
    }
}
fn snap(s: &mut Segment, events: Vec<Event>, spec: Vec<SpecInterval>, cursor: f64) {
    s.events = events.into_iter().filter(|e| s.owns(e.t)).collect();
    s.spec = clip_intervals(
        &spec,
        s.own_from,
        if s.last { f64::INFINITY } else { s.end },
    );
    s.snap_progress = cursor;
}
fn flush(
    state: &State,
    det: &mut Detector,
    tracker: &mut EventTracker,
    buf: &mut Option<Vec<(f64, Prepared)>>,
) -> Result<bool> {
    if buf.is_none() {
        return Ok(true);
    }
    let Some(kw) = state.learning.as_ref().and_then(|l| l.keywords.as_ref()) else {
        return Ok(false);
    };
    det.set_keywords(Some(kw.clone()));
    for (t, r) in buf.take().unwrap() {
        tracker.feed(t, det.resolve(&r)?);
    }
    Ok(true)
}
struct Worker<'a, 'b> {
    path: &'a str,
    doc: &'a Document<'a>,
    opts: &'a AnalyzeOptions<'b>,
    cp: &'a Path,
    state: &'a Mutex<State>,
    abort: &'a AtomicBool,
}
impl Worker<'_, '_> {
    fn stopped(&self) -> bool {
        self.abort.load(Ordering::Relaxed) || calibrate::stopped(self.opts.cancel)
    }
    fn work(&self, i: usize) -> Result<()> {
        let (sg, keywords, learning) = {
            let s = self.state.lock().unwrap();
            (s.segs[i].clone(), s.keywords.clone(), s.learning.is_some())
        };
        let (_, start) = sg.resume_plan();
        let p = self.doc.profile;
        let mut det = Detector::new(p, self.doc.scale.unwrap(), None, keywords)?;
        let mut tracker = EventTracker::new(p, None);
        let mut feed = p
            .killfeed_roi
            .map(|_| crate::control_feed::ControlFeed::new(p))
            .transpose()?;
        let mut buf = learning.then(Vec::new);
        let mut log = learning.then(Vec::new);
        let mut collect = true;
        let mut late_collect = true;
        let mut cursor = start;
        let mut last_save = start;
        let mut stream = FrameStream::new(
            self.path,
            p.clone(),
            DecodeOptions {
                start,
                end: sg.decode_end(),
                hwaccel: self.opts.hwaccel,
                codec: Some(self.doc.info.codec.clone()),
            },
        );
        while let Some(frame) = stream.next_cancellable(&|| self.stopped()) {
            if self.stopped() {
                let mut state = self.state.lock().unwrap();
                if flush(&state, &mut det, &mut tracker, &mut buf)? {
                    let (evs, spec) = tracker.snapshot();
                    snap(&mut state.segs[i], evs, spec, cursor);
                    state.segs[i].feed_events = feed.as_ref().map_or_else(Vec::new, |f| {
                        f.events.iter().filter(|e| sg.owns(e.t)).cloned().collect()
                    });
                }
                return Ok(());
            }
            let (t, mut banner, spec) = frame?;
            if let Some(feed) = &mut feed {
                feed.feed(t, stream.killfeed.as_ref(), &spec, stream.thumb.as_ref())?;
                if feed.active {
                    banner.data.fill(0);
                }
            }
            let (r, f) = det.prepare(&banner, &spec)?;
            let emit = {
                let mut state = self.state.lock().unwrap();
                if let Some(l) = &mut state.learning {
                    let (lo, hi) = l.spans[i];
                    if collect && l.waiting[i] {
                        if t >= lo - 1e-6 && t < hi - 1e-6 {
                            l.cols[i].feed_features(t, &banner, &f, &det)?;
                        }
                        if t >= hi - 1e-6 || l.cols[i].full(t) {
                            collect = false;
                            l.finish(i)?;
                        }
                    }
                    if let Some(logged) = &mut log {
                        if l.keywords.is_some() && !l.late() {
                            log = None;
                            late_collect = false;
                        } else {
                            logged.push((t, r.clone()));
                            let (lo, hi) = l.late_spans[i];
                            if late_collect && t >= lo - 1e-6 && t < hi - 1e-6 {
                                l.late_cols[i].feed_features(t, &banner, &f, &det)?;
                                if l.late_cols[i].full(t) {
                                    late_collect = false;
                                }
                            }
                        }
                    }
                }
                if flush(&state, &mut det, &mut tracker, &mut buf)? {
                    tracker.feed(t, det.resolve(&r)?);
                } else {
                    buf.as_mut().unwrap().push((t, r));
                }
                cursor = t;
                state.segs[i].progress = state.segs[i].progress.max(t);
                let now = Instant::now();
                let emit = if state
                    .last_emit
                    .is_none_or(|last| now.duration_since(last) >= Duration::from_millis(250))
                {
                    state.last_emit = Some(now);
                    Some(state.segs.iter().map(|s| s.contribution(s.progress)).sum())
                } else {
                    None
                };
                if buf.is_none() && log.is_none() && t - last_save >= 30. {
                    last_save = t;
                    let (evs, spec) = tracker.snapshot();
                    snap(&mut state.segs[i], evs, spec, t);
                    state.segs[i].feed_events = feed.as_ref().map_or_else(Vec::new, |f| {
                        f.events.iter().filter(|e| sg.owns(e.t)).cloned().collect()
                    });
                    save(
                        self.cp,
                        &mut self.doc.partial(Some(&state)),
                        self.opts.cache_dir,
                    )?;
                }
                emit
            };
            if let Some(t) = emit {
                (self.opts.on_progress)(t, self.doc.info.duration);
            }
        }
        {
            let mut state = self.state.lock().unwrap();
            if let Some(l) = &mut state.learning {
                l.finish(i)?;
            }
        }
        loop {
            let state = self.state.lock().unwrap();
            if flush(&state, &mut det, &mut tracker, &mut buf)? {
                break;
            }
            drop(state);
            if self.stopped() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let (events, spec) = tracker.finish();
        let mut state = self.state.lock().unwrap();
        if state.learning.as_ref().is_some_and(Learning::late) {
            state.replays[i] = log;
        }
        let target = sg.target();
        snap(&mut state.segs[i], events, spec, target);
        state.segs[i].feed_events = feed.as_ref().map_or_else(Vec::new, |f| {
            f.events.iter().filter(|e| sg.owns(e.t)).cloned().collect()
        });
        state.segs[i].progress = target;
        Ok(())
    }
}
pub(super) fn run(
    path: &str,
    doc: &Document<'_>,
    opts: &AnalyzeOptions<'_>,
    cp: &Path,
    state: &Mutex<State>,
    abort: &AtomicBool,
) -> Result<()> {
    let todo: Vec<_> = state
        .lock()
        .unwrap()
        .segs
        .iter()
        .enumerate()
        .filter_map(|(i, s)| (!s.done()).then_some(i))
        .collect();
    let worker = Worker {
        path,
        doc,
        opts,
        cp,
        state,
        abort,
    };
    std::thread::scope(|scope| {
        let handles: Vec<_> = todo
            .into_iter()
            .map(|i| {
                let w = &worker;
                scope.spawn(move || {
                    let r = w.work(i);
                    if r.is_err() {
                        abort.store(true, Ordering::Relaxed);
                    }
                    r
                })
            })
            .collect();
        let mut first = None;
        for h in handles {
            let r = h
                .join()
                .unwrap_or_else(|_| Err(anyhow::anyhow!("Analysis worker panicked")));
            if let Err(e) = r {
                if first.is_none() {
                    first = Some(e);
                }
            }
        }
        first.map_or(Ok(()), Err)
    })
}
pub(super) fn finalize(state: &mut State, p: &Profile, scale: f64) -> Result<()> {
    let Some(l) = &mut state.learning else {
        return Ok(());
    };
    let kw = l.keywords.clone().unwrap_or_default();
    let final_kw = if l.late() {
        let cols: Vec<_> = l.cols.iter().chain(&l.late_cols).cloned().collect();
        extend_keywords(&kw, &build_keywords(&cols)?)
    } else {
        kw.clone()
    };
    let changed = !same_keywords(Some(&final_kw), Some(&kw));
    l.final_kw = Some(final_kw.clone());
    if changed {
        let det = Detector::new(p, scale, None, Some(final_kw))?;
        for (i, log) in state.replays.iter_mut().enumerate() {
            if let Some(log) = log.take() {
                let mut tracker = EventTracker::new(p, None);
                for (t, r) in log {
                    tracker.feed(t, det.resolve(&r)?);
                }
                let (evs, spec) = tracker.finish();
                let target = state.segs[i].target();
                snap(&mut state.segs[i], evs, spec, target);
            }
        }
    }
    Ok(())
}
