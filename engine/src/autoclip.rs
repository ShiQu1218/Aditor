use crate::{
    derive::is_counted,
    models::{AutoClipParams, Clip, Event},
};
use std::collections::HashMap;

pub fn auto_clips(events: &[Event], p: &AutoClipParams, duration: f64) -> Vec<Clip> {
    let mut events: Vec<_> = events.iter().filter(|e| is_counted(e)).collect();
    events.sort_by(|a, b| a.t.total_cmp(&b.t));
    let mut groups: Vec<Vec<&Event>> = Vec::new();
    for e in &events {
        if groups
            .last()
            .is_none_or(|g| e.t - g.last().unwrap().t > p.gap)
        {
            groups.push(Vec::new());
        }
        groups.last_mut().unwrap().push(e);
    }
    let times: HashMap<_, _> = events.iter().map(|e| (e.id.as_str(), e.t)).collect();
    let n = p.n.max(1) as usize;
    let mut clips: Vec<Clip> = Vec::new();
    for g in groups {
        let gaps = GapIndex::new(&g);
        let mut pending = vec![(0, g.len())];
        while let Some((lo, hi)) = pending.pop() {
            if hi - lo < n {
                continue;
            }
            let mut start = 0f64.max(g[lo].t - p.before);
            let mut end = duration.min(g[hi - 1].t + p.after);
            if end <= start {
                continue;
            }
            if end - start > p.max_len + 1e-9 {
                if g[hi - 1].t == g[lo].t {
                    start = 0f64.max(g[lo].t - p.max_len / 2.);
                    end = duration.min(start + p.max_len);
                    if end - start < p.max_len && start > 0. {
                        start = 0f64.max(end - p.max_len);
                    }
                } else {
                    let (a, b) = if hi - lo >= 2 * n {
                        (lo + n - 1, hi - n)
                    } else {
                        (lo, hi - 1)
                    };
                    let best = gaps.largest(a, b);
                    pending.push((best + 1, hi));
                    pending.push((lo, best + 1));
                    continue;
                }
            }
            clips.push(Clip {
                id: String::new(),
                start,
                end,
                origin: "ai".into(),
                event_ids: g[lo..hi].iter().map(|e| e.id.clone()).collect(),
            });
        }
    }
    loop {
        clips.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
        let mut changed = false;
        let mut i = 0;
        while i + 1 < clips.len() {
            if clips[i + 1].start < clips[i].end {
                let end = clips[i].end.max(clips[i + 1].end);
                if end - clips[i].start <= p.max_len + 1e-9 {
                    let next = clips.remove(i + 1);
                    clips[i].end = end;
                    for id in next.event_ids {
                        if !clips[i].event_ids.contains(&id) {
                            clips[i].event_ids.push(id);
                        }
                    }
                    clips[i]
                        .event_ids
                        .sort_by(|a, b| times[a.as_str()].total_cmp(&times[b.as_str()]));
                    changed = true;
                    continue;
                }
                let mid = (clips[i + 1].start + clips[i].end) / 2.;
                if (clips[i].end - mid).abs() > 1e-9 || (clips[i + 1].start - mid).abs() > 1e-9 {
                    clips[i].end = mid;
                    clips[i + 1].start = mid;
                    changed = true;
                }
            }
            i += 1;
        }
        if !changed {
            break;
        }
    }
    clips.retain(|c| c.end > c.start);
    for c in &mut clips {
        c.id = format!("c{}", (c.start * 1000.).round_ties_even() as i64);
    }
    clips
}

// Equal gaps choose the leftmost index, matching the original strict-greater scan.
struct GapIndex {
    size: usize,
    tree: Vec<(f64, usize)>,
}
impl GapIndex {
    fn better(a: (f64, usize), b: (f64, usize)) -> (f64, usize) {
        if b.0 > a.0 || (b.0 == a.0 && b.1 < a.1) {
            b
        } else {
            a
        }
    }
    fn new(events: &[&Event]) -> Self {
        let size = events.len().max(1).next_power_of_two();
        let mut tree = vec![(f64::NEG_INFINITY, usize::MAX); 2 * size];
        for (i, pair) in events.windows(2).enumerate() {
            tree[size + i] = (pair[1].t - pair[0].t, i);
        }
        for i in (1..size).rev() {
            tree[i] = Self::better(tree[2 * i], tree[2 * i + 1]);
        }
        Self { size, tree }
    }
    fn largest(&self, start: usize, end: usize) -> usize {
        let (mut lo, mut hi) = (start + self.size, end + self.size);
        let mut best = (f64::NEG_INFINITY, usize::MAX);
        while lo < hi {
            if lo % 2 == 1 {
                best = Self::better(best, self.tree[lo]);
                lo += 1;
            }
            if hi % 2 == 1 {
                hi -= 1;
                best = Self::better(best, self.tree[hi]);
            }
            lo /= 2;
            hi /= 2;
        }
        best.1
    }
}

#[cfg(test)]
#[path = "autoclip_tests.rs"]
mod tests;
