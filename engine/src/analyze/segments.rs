use crate::models::{Event, SpecInterval};
use serde::{Deserialize, Serialize};

pub const RESUME_BACK: f64 = 12.;
pub const SEGMENT_PREROLL: f64 = 20.;
pub const SEGMENT_POSTROLL: f64 = 12.;
const SEGMENT_GRID: f64 = 0.25;

pub fn plan_segments(duration: f64, jobs: usize, min_len: f64) -> Vec<(f64, f64)> {
    let n = jobs
        .min(if min_len > 0. {
            (duration / min_len).floor() as usize
        } else {
            jobs
        })
        .max(1);
    let mut bounds = vec![0.];
    if n > 1 {
        if duration > SEGMENT_PREROLL + SEGMENT_POSTROLL {
            // Each inner boundary adds one preroll and one postroll to the
            // decoded work, so the decoded spans add up to the file length
            // plus (n - 1) * (preroll + postroll). Spread that budget over
            // the first n - 1 spans on the boundary grid; the last span
            // takes the remainder.
            let total = duration + (n - 1) as f64 * (SEGMENT_PREROLL + SEGMENT_POSTROLL);
            let base = (total / (n as f64 * SEGMENT_GRID)).floor() * SEGMENT_GRID;
            let extra =
                (((total - base * n as f64).max(0.) / SEGMENT_GRID).floor() as usize).min(n - 1);
            let mut at = 0.;
            for i in 0..n - 1 {
                at += base + if i < extra { SEGMENT_GRID } else { 0. }
                    - if i == 0 {
                        SEGMENT_POSTROLL
                    } else {
                        SEGMENT_PREROLL + SEGMENT_POSTROLL
                    };
                bounds.push(at);
            }
        } else {
            // The file is not longer than the overlap: every segment decodes
            // the whole file when all boundaries stay inside this grid window.
            let lo = ((duration - SEGMENT_POSTROLL).max(0.) / SEGMENT_GRID).ceil() * SEGMENT_GRID;
            let hi = (duration.min(SEGMENT_PREROLL) / SEGMENT_GRID).floor() * SEGMENT_GRID;
            for i in 1..n {
                bounds.push(
                    ((lo + (hi - lo) * i as f64 / n as f64) / SEGMENT_GRID).round_ties_even()
                        * SEGMENT_GRID,
                );
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn planner_preserves_count_grid_and_coverage() {
        for (duration, min_len, limit) in [
            (0., 5., 1),
            (0.1, 0., 8),
            (6., 30., 1),
            (29.9, 5., 5),
            (30., 30., 1),
            (32.1, 5., 6),
            (59.9, 30., 1),
            (60., 30., 2),
            (112.16, 0., 8),
            (226.1, 30., 7),
            (226., 0., 8),
        ] {
            for jobs in 1..=8 {
                let plan = plan_segments(duration, jobs, min_len);
                assert_eq!(plan.len(), jobs.min(limit).max(1));
                assert_eq!(plan[0].0, 0.);
                assert_eq!(plan.last().unwrap().1, duration);
                for (i, &(start, end)) in plan.iter().enumerate() {
                    assert!(start >= 0. && start <= end && end <= duration);
                    assert_eq!(start % 0.25, 0.);
                    if i > 0 {
                        assert_eq!(plan[i - 1].1, start);
                    }
                }
            }
        }
    }

    fn decode_stats(plan: &[(f64, f64)], duration: f64) -> (f64, f64) {
        let lengths: Vec<_> = plan
            .iter()
            .enumerate()
            .map(|(i, &(a, b))| {
                let s = Segment::new(a, b, i + 1 == plan.len(), duration);
                s.target() - s.resume_plan().1
            })
            .collect();
        let shortest = lengths.iter().copied().fold(f64::INFINITY, f64::min);
        let longest = lengths.iter().copied().fold(0., f64::max);
        (longest, longest - shortest)
    }

    #[test]
    fn planner_balances_clamped_decode_lengths() {
        for duration in [
            0.1, 6., 12., 12.1, 20., 29.9, 30., 31.8, 32., 32.1, 34., 50.5, 60., 112.16, 226.,
            226.083008, 226.1,
        ] {
            for jobs in 1..=8 {
                for min_len in [0., 5., 30.] {
                    let plan = plan_segments(duration, jobs, min_len);
                    let (longest, spread) = decode_stats(&plan, duration);
                    let limit = if duration <= SEGMENT_PREROLL + SEGMENT_POSTROLL {
                        0.
                    } else {
                        SEGMENT_GRID
                    };
                    assert!(
                        spread <= limit + 1e-9,
                        "duration={duration}, jobs={jobs}, min_len={min_len}: spread={spread}, plan={plan:?}"
                    );
                    for i in 1..plan.len() {
                        for step in [-SEGMENT_GRID, SEGMENT_GRID] {
                            let cand = plan[i].0 + step;
                            if cand >= plan[i - 1].0 && cand <= plan[i].1 {
                                let mut alt = plan.clone();
                                alt[i - 1].1 = cand;
                                alt[i].0 = cand;
                                let (alt_longest, alt_spread) = decode_stats(&alt, duration);
                                assert!(
                                    alt_longest >= longest - 1e-9
                                        && (alt_longest > longest + 1e-9
                                            || alt_spread >= spread - 1e-9),
                                    "non-optimal at duration={duration}, jobs={jobs}, min_len={min_len}: {plan:?} vs {alt:?}"
                                );
                            }
                        }
                    }
                }
            }
        }
        assert_eq!(
            plan_segments(226., 4, 30.),
            vec![(0., 68.5), (68.5, 117.), (117., 165.5), (165.5, 226.)]
        );
        assert_eq!(
            plan_segments(34., 3, 5.),
            vec![(0., 20.75), (20.75, 21.5), (21.5, 34.)]
        );
    }

    #[test]
    fn legacy_checkpoint_keeps_bounds_progress_and_resume_ownership() {
        let raw = json!([
            {"start":0.,"end":56.5,"progress_t":68.5},
            {"start":56.5,"end":113.,"progress_t":90.},
            {"start":113.,"end":169.5,"progress_t":113.},
            {"start":169.5,"end":226.,"progress_t":190.}
        ]);
        let mut segs = restore(&raw, 226.).unwrap();
        assert_eq!(serde_json::to_value(&segs).unwrap(), raw);
        assert!(segs[0].done());
        assert_eq!(segs[1].resume_plan(), (78., 58.));
        assert_eq!(segs[2].resume_plan(), (113., 93.));
        assert_eq!(segs[3].resume_plan(), (178., 158.));
        for s in &mut segs {
            s.own_from = if s.done() { s.end } else { s.resume_plan().0 };
            assert_eq!(s.owns(s.own_from), !s.done() || s.last);
            assert_eq!(s.owns(s.end), s.last);
        }
    }
}
