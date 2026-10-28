use crate::models::{Event, SpecInterval};
use serde::{Deserialize, Serialize};

pub const RESUME_BACK: f64 = 12.;
pub const SEGMENT_PREROLL: f64 = 20.;
pub const SEGMENT_POSTROLL: f64 = 12.;

pub fn plan_segments(duration: f64, jobs: usize, min_len: f64) -> Vec<(f64, f64)> {
    let n = jobs
        .min(if min_len > 0. {
            (duration / min_len).floor() as usize
        } else {
            jobs
        })
        .max(1);
    let mut bounds = vec![0.];
    bounds.extend((1..n).map(|i| (duration * i as f64 / n as f64 / 0.25).round_ties_even() * 0.25));
    bounds.push(duration);
    bounds.windows(2).map(|w| (w[0], w[1])).collect()
}

pub fn auto_jobs(gpu: bool) -> usize {
    if gpu {
        (std::thread::available_parallelism().map_or(4, usize::from) / 4).clamp(1, 4)
    } else {
        1
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    #[serde(rename = "progress_t")]
    pub snap_progress: f64,
    #[serde(skip)]
    pub progress: f64,
    #[serde(skip)]
    pub last: bool,
    #[serde(skip)]
    pub duration: f64,
    #[serde(skip)]
    pub own_from: f64,
    #[serde(skip)]
    pub events: Vec<Event>,
    #[serde(skip)]
    pub feed_events: Vec<Event>,
    #[serde(skip)]
    pub spec: Vec<SpecInterval>,
}
impl Segment {
    pub fn new(start: f64, end: f64, last: bool, duration: f64) -> Self {
        Self {
            start,
            end,
            snap_progress: start,
            progress: start,
            last,
            duration,
            own_from: start,
            events: vec![],
            feed_events: vec![],
            spec: vec![],
        }
    }
    pub fn decode_end(&self) -> Option<f64> {
        (!self.last).then_some((self.end + SEGMENT_POSTROLL).min(self.duration))
    }
    pub fn target(&self) -> f64 {
        self.decode_end().unwrap_or(self.end)
    }
    pub fn done(&self) -> bool {
        self.progress >= self.target() - 1e-6
    }
    pub fn resume_plan(&self) -> (f64, f64) {
        let own = if self.snap_progress <= self.start + 1e-6 {
            self.start
        } else {
            self.start.max(self.snap_progress - RESUME_BACK)
        };
        (own, (own - SEGMENT_PREROLL).max(0.))
    }
    pub fn owns(&self, t: f64) -> bool {
        t >= self.own_from - 1e-6 && (self.last || t < self.end - 1e-6)
    }
    pub fn contribution(&self, t: f64) -> f64 {
        (t - self.start).max(0.).min(self.end - self.start)
    }
}
pub fn restore(raw: &serde_json::Value, duration: f64) -> Option<Vec<Segment>> {
    let mut segs: Vec<Segment> = serde_json::from_value(raw.clone()).ok()?;
    if segs.is_empty()
        || segs[0].start != 0.
        || (segs.last()?.end - duration).abs() > 1e-6
        || segs
            .windows(2)
            .any(|w| (w[0].end - w[1].start).abs() > 1e-6)
    {
        return None;
    }
    for s in &mut segs {
        s.duration = duration;
        s.progress = s.snap_progress;
    }
    segs.last_mut()?.last = true;
    Some(segs)
}
pub fn clip_intervals(items: &[SpecInterval], lo: f64, hi: f64) -> Vec<SpecInterval> {
    items
        .iter()
        .filter_map(|s| {
            let (start, end) = (s.start.max(lo), s.end.min(hi));
            (end > start).then_some(SpecInterval { start, end })
        })
        .collect()
}
pub fn cut_intervals(items: &[SpecInterval], lo: f64, hi: f64) -> Vec<SpecInterval> {
    let mut out = vec![];
    for s in items {
        if s.end <= lo || s.start >= hi {
            out.push(s.clone());
            continue;
        }
        if s.start < lo {
            out.push(SpecInterval {
                start: s.start,
                end: lo,
            });
        }
        if s.end > hi {
            out.push(SpecInterval {
                start: hi,
                end: s.end,
            });
        }
    }
    out
}
pub fn merge_intervals(mut items: Vec<SpecInterval>) -> Vec<SpecInterval> {
    items.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut out: Vec<SpecInterval> = vec![];
    for s in items {
        if let Some(last) = out.last_mut().filter(|p| s.start <= p.end) {
            last.end = last.end.max(s.end);
        } else {
            out.push(s);
        }
    }
    out
}
