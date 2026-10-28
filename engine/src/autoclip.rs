use crate::{
    derive::is_counted,
    models::{AutoClipParams, Clip, Event},
};

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
    let n = p.n.max(1) as usize;
    let mut clips: Vec<Clip> = Vec::new();
    for g in groups {
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
                    let mut best = a;
                    for i in a + 1..b {
                        if g[i + 1].t - g[i].t > g[best + 1].t - g[best].t {
                            best = i;
                        }
                    }
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
                    clips[i].event_ids.sort_by(|a, b| {
                        let time =
                            |id: &String| events.iter().rev().find(|e| &e.id == id).unwrap().t;
                        time(a).total_cmp(&time(b))
                    });
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
