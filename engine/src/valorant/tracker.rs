use super::FeedRow;
use crate::models::Event;
#[derive(Clone)]
struct Track {
    first: f64,
    last: f64,
    row: FeedRow,
    anchor: FeedRow,
    sightings: Vec<f64>,
    event: bool,
    strong: usize,
    defer: bool,
    missing: Option<f64>,
}
fn dot(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum::<f32>() as f64
}
pub struct FeedTracker {
    seen: Vec<Track>,
    last_death: f64,
    pub events: Vec<Event>,
}
impl Default for FeedTracker {
    fn default() -> Self {
        Self {
            seen: vec![],
            last_death: -1e9,
            events: vec![],
        }
    }
}
impl FeedTracker {
    pub fn feed(&mut self, t: f64, rows: &[FeedRow]) -> Vec<Event> {
        self.seen.retain(|s| {
            t - s.first <= 7.
                && s.missing.is_none_or(|v| t - v <= 1.5)
                && (s.event || t - s.last <= 1.5)
        });
        let mut edges = vec![];
        for (j, row) in rows.iter().enumerate() {
            for (i, s) in self.seen.iter().enumerate() {
                if s.row.kind != row.kind || row.slot > s.row.slot {
                    continue;
                }
                let raw = dot(&s.row.signature, &row.signature)
                    .max(dot(&s.anchor.signature, &row.signature));
                let identities: Vec<_> = [&s.row, &s.anchor]
                    .iter()
                    .filter_map(|r| r.identity.as_ref())
                    .collect();
                let (score, threshold) =
                    if let Some(id) = row.identity.as_ref().filter(|_| !identities.is_empty()) {
                        (
                            0.35 * raw
                                + 0.65
                                    * identities
                                        .iter()
                                        .map(|v| dot(v, id))
                                        .fold(f64::NEG_INFINITY, f64::max),
                            0.65,
                        )
                    } else {
                        (
                            raw,
                            if s.event && row.slot < s.row.slot && t - s.last <= 1.5 {
                                0.72
                            } else {
                                0.80
                            },
                        )
                    };
                if score >= threshold {
                    edges.push((s.event, score, j, i));
                }
            }
        }
        edges.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(b.1.total_cmp(&a.1))
                .then(b.2.cmp(&a.2))
                .then(b.3.cmp(&a.3))
        });
        let mut assigned = vec![None; rows.len()];
        let mut taken = std::collections::HashSet::new();
        for (_, _, j, i) in edges {
            if assigned[j].is_none() && !taken.contains(&i) {
                assigned[j] = Some(i);
                taken.insert(i);
            }
        }
        for (j, row) in rows.iter().enumerate() {
            if assigned[j].is_some() || !row.confirmed {
                continue;
            }
            let candidate = self
                .seen
                .iter()
                .enumerate()
                .filter(|(i, s)| {
                    !taken.contains(i)
                        && s.event
                        && s.row.kind == row.kind
                        && s.row.slot == row.slot
                        && t - s.last <= 1.5
                        && !(row.identity.is_some()
                            && (s.row.identity.is_some() || s.anchor.identity.is_some()))
                })
                .max_by(|a, b| a.1.last.total_cmp(&b.1.last));
            if let Some((i, _)) = candidate {
                assigned[j] = Some(i);
                taken.insert(i);
            }
        }
        let mut order: Vec<_> = (0..rows.len()).collect();
        order.sort_by_key(|&j| rows[j].slot);
        let mut new = vec![];
        for j in order {
            let row = &rows[j];
            let i = if let Some(i) = assigned[j] {
                let s = &mut self.seen[i];
                if !s.event && t - s.last > 0.5 {
                    s.sightings.clear();
                    s.strong = 0;
                }
                s.last = t;
                s.row = row.clone();
                s.missing = None;
                s.sightings.push(t);
                s.sightings.retain(|v| t - v <= 3.);
                i
            } else {
                let above = assigned.iter().enumerate().any(|(other, a)| {
                    a.is_some() && rows[other].kind == row.kind && rows[other].slot == row.slot + 1
                });
                let replaced = self.seen.iter().any(|s| {
                    s.event && s.row.kind == row.kind && s.row.slot == row.slot && t - s.last <= 1.5
                });
                self.seen.push(Track {
                    first: t,
                    last: t,
                    row: row.clone(),
                    anchor: row.clone(),
                    sightings: vec![t],
                    event: false,
                    strong: 0,
                    defer: above || replaced,
                    missing: None,
                });
                self.seen.len() - 1
            };
            let s = &mut self.seen[i];
            if !row.confirmed || s.event {
                continue;
            }
            s.strong += 1;
            if s.defer && s.strong < 2 {
                continue;
            }
            let at = if s.sightings.len() >= 2 {
                s.sightings[0]
            } else {
                t
            };
            if row.kind == "death" && at - self.last_death < 6. {
                continue;
            }
            if row.kind == "death" {
                self.last_death = at;
            }
            let base = format!("v{}", (at * 1000.).round_ties_even() as i64);
            let mut id = base.clone();
            let mut n = 1;
            while self.events.iter().any(|e| e.id == id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            let kill = row.kind == "kill";
            let ev = Event {
                id,
                t: (at * 1000.).round_ties_even() / 1000.,
                kind: row.kind.clone(),
                score: 1.,
                damage_line: false,
                name_sig: None,
                counted: kill,
                counted_reason: if kill { "first" } else { "death" }.into(),
                counted_override: None,
                source: "auto".into(),
                deleted: false,
            };
            s.event = true;
            s.anchor = row.clone();
            self.events.push(ev.clone());
            new.push(ev);
        }
        for s in &mut self.seen {
            if !rows.is_empty() {
                s.missing = None;
            } else {
                s.missing.get_or_insert(t);
            }
        }
        new
    }
}
