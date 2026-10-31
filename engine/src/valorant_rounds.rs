use crate::{
    cv::{self, Image},
    models::Event,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Round {
    pub start: f64,
    pub end: f64,
    pub winner: String,
    pub ally: usize,
    pub enemy: usize,
}
#[derive(Default)]
struct Side {
    stable: Option<Vec<bool>>,
    cand: Option<Vec<bool>>,
    count: usize,
    seen: Vec<Vec<bool>>,
}
fn iou(a: &[bool], b: &[bool]) -> f64 {
    a.iter().zip(b).filter(|(a, b)| **a && **b).count() as f64
        / a.iter().zip(b).filter(|(a, b)| **a || **b).count().max(1) as f64
}
fn update(s: &mut Side, g: Vec<bool>, stable_frames: usize) -> bool {
    if s.stable.as_ref().is_some_and(|old| iou(&g, old) >= 0.75) {
        s.cand = None;
        s.count = 0;
        return false;
    }
    if s.cand.as_ref().is_some_and(|old| iou(&g, old) >= 0.75) {
        s.count += 1;
    } else {
        s.cand = Some(g);
        s.count = 1;
    }
    if s.count < stable_frames {
        return false;
    }
    let g = s.cand.take().unwrap();
    s.count = 0;
    let first = s.stable.is_none();
    s.stable = Some(g.clone());
    if s.seen.iter().any(|old| iou(&g, old) >= 0.75) {
        return false;
    }
    s.seen.push(g);
    !first
}
pub struct RoundTracker {
    origin: (i32, i32),
    stable_frames: usize,
    last_frames: usize,
    frame: f64,
    pending: Option<(usize, f64, f64, Vec<bool>)>,
    sides: [Side; 2],
    pub rounds: Vec<Round>,
    match_start: Option<f64>,
    last_seen: Option<f64>,
    score: [usize; 2],
}
impl RoundTracker {
    pub fn new(origin: (i32, i32), fps: f64) -> Self {
        Self {
            origin,
            stable_frames: (2. * fps).round_ties_even().max(1.) as usize,
            last_frames: (0.75 * fps).round_ties_even().max(1.) as usize,
            frame: 1. / fps,
            pending: None,
            sides: Default::default(),
            rounds: vec![],
            match_start: None,
            last_seen: None,
            score: [0; 2],
        }
    }
    fn glyph(&self, crop: &Image<u8>, x: i32) -> Result<Option<Vec<bool>>> {
        let (x, y) = (x - self.origin.0, 34 - self.origin.1);
        if x < 0 || y < 0 || x + 52 > crop.width as i32 || y + 32 > crop.height as i32 {
            return Ok(None);
        }
        let hsv = cv::hsv(&crop.crop(x as usize, y as usize, 52, 32)?)?;
        let mut values: Vec<_> = hsv.data.as_chunks::<3>().0.iter().map(|p| p[2]).collect();
        values.sort_unstable();
        let median = (values[values.len() / 2 - 1] as i32 + values[values.len() / 2] as i32) / 2;
        let mask: Vec<_> = hsv
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| p[2] as i32 >= 200.max(median + 45) && p[1] <= 50)
            .collect();
        let ink = mask.iter().filter(|&&b| b).count();
        if !(30..=700).contains(&ink) {
            return Ok(None);
        }
        let sat = hsv
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .zip(&mask)
            .filter(|(_, b)| !**b)
            .map(|(p, _)| p[1] as f64)
            .sum::<f64>()
            / (mask.len() - ink) as f64;
        Ok((sat <= 70.).then_some(mask))
    }
    fn deathmatch(&self, crop: &Image<u8>) -> Result<bool> {
        let (x, y) = (742 - self.origin.0, 34 - self.origin.1);
        let region = crate::detect::crop(crop, x.max(0), y, x + 54, y + 30);
        if region.data.is_empty() {
            return Ok(false);
        }
        let hsv = cv::hsv(&region)?;
        Ok(hsv
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .filter(|p| (p[0] <= 10 || p[0] >= 170) && p[1] >= 60 && p[2] >= 90)
            .count() as f64
            / (region.width * region.height) as f64
            >= 0.10)
    }
    fn decided(&self) -> bool {
        self.score[0].max(self.score[1]) >= 13 && self.score[0].abs_diff(self.score[1]) >= 2
    }
    fn reset(&mut self) {
        self.pending = None;
        self.sides = Default::default();
        self.match_start = None;
        self.score = [0; 2];
    }
    fn won(&mut self, side: usize, at: f64) -> Option<Round> {
        let start = self.match_start?;
        let last = self
            .rounds
            .last()
            .filter(|r| r.start >= start)
            .map(|r| r.end);
        if last.is_some_and(|end| at - end < 25.) {
            return None;
        }
        self.score[side] += 1;
        let r = Round {
            start: last.unwrap_or(start),
            end: (at * 1000.).round_ties_even() / 1000.,
            winner: if side == 0 { "ally" } else { "enemy" }.into(),
            ally: self.score[0],
            enemy: self.score[1],
        };
        self.rounds.push(r.clone());
        Some(r)
    }
    pub fn feed(&mut self, t: f64, crop: &Image<u8>) -> Result<Option<Round>> {
        if self.deathmatch(crop)? {
            return Ok(None);
        }
        let glyphs = [self.glyph(crop, 800)?, self.glyph(crop, 1072)?];
        if glyphs.iter().all(Option::is_none) {
            if self.pending.is_none() && self.match_start.is_some() && !self.decided() {
                for (i, s) in self.sides.iter().enumerate() {
                    if let Some(g) = s.cand.as_ref().filter(|g| {
                        s.count >= self.last_frames
                            && s.stable.is_some()
                            && !s.seen.iter().any(|old| iou(g, old) >= 0.75)
                    }) {
                        self.pending = Some((i, t - self.frame * s.count as f64, t, g.clone()));
                        break;
                    }
                }
            }
            let mut final_round = None;
            if self.pending.as_ref().is_some_and(|p| t - p.2 >= 15.) {
                let (i, at, _, g) = self.pending.take().unwrap();
                let s = &mut self.sides[i];
                s.seen.push(g.clone());
                s.stable = Some(g);
                s.cand = None;
                s.count = 0;
                final_round = self.won(i, at);
            }
            if self.last_seen.is_some_and(|last| t - last > 60.) {
                self.reset();
            }
            return Ok(final_round);
        }
        self.pending = None;
        if self.last_seen.is_none_or(|last| t - last > 60.) {
            self.reset();
        }
        self.last_seen = Some(t);
        self.match_start.get_or_insert(t);
        if self.decided() {
            return Ok(None);
        }
        let mut won = None;
        for (i, g) in glyphs.into_iter().enumerate() {
            if let Some(g) = g {
                if update(&mut self.sides[i], g, self.stable_frames) && won.is_none() {
                    won = Some(i);
                }
            }
        }
        Ok(won.and_then(|i| self.won(i, t - (self.stable_frames - 1) as f64 * self.frame)))
    }
}
pub fn round_highlights(events: &[Event], rounds: &[Round]) -> Vec<Event> {
    let mut assigned = std::collections::HashSet::new();
    let mut out = vec![];
    let mut eligible: Vec<_> = events
        .iter()
        .filter(|e| {
            e.kind == "kill"
                && !e.deleted
                && e.counted_override.unwrap_or(e.counted)
                && !e.t.is_nan()
        })
        .collect();
    eligible.sort_by(|a, b| a.t.total_cmp(&b.t));
    for r in rounds {
        if r.start.is_nan() || r.end.is_nan() {
            continue;
        }
        let lo = eligible.partition_point(|e| e.t < r.start);
        let hi = eligible.partition_point(|e| e.t < r.end + 3.);
        if hi <= lo {
            continue;
        }
        let kills: Vec<_> = eligible[lo..hi]
            .iter()
            .copied()
            .filter(|e| !assigned.contains(&e.id))
            .collect();
        for e in &kills {
            assigned.insert(e.id.clone());
        }
        if kills.len() < 2 {
            continue;
        }
        let last = kills.last().unwrap();
        out.push(Event {
            id: format!("r{}", (last.t * 1000.).round_ties_even() as i64),
            t: last.t,
            kind: if kills.len() >= 5 { "ace" } else { "multikill" }.into(),
            score: kills.len() as f64,
            damage_line: false,
            name_sig: None,
            counted: false,
            counted_reason: "highlight".into(),
            counted_override: None,
            source: "auto".into(),
            deleted: false,
        });
    }
    out
}
