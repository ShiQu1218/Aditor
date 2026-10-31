// Frozen pre-optimization implementation: differential oracle, not production code.
use crate::{
    derive::is_counted,
    models::{AutoClipParams, Clip, Event},
};

fn reference(events: &[Event], p: &AutoClipParams, duration: f64) -> Vec<Clip> {
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

fn event(i: usize, t: f64) -> Event {
    serde_json::from_value(serde_json::json!({"id": format!("e{}", i), "t":t,
        "type":"kill", "score":1.0, "damage_line":false, "name_sig":null,
        "counted":true, "counted_reason":"first", "counted_override":null, "source":"auto"}))
    .unwrap()
}
#[test]
fn indexed_matches_reference() {
    let mut seed = 19u64;
    for case in 0..400 {
        let mut events = Vec::new();
        let mut t = 0.;
        for i in 0..case % 100 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            t += ((seed >> 32) % 12) as f64 * 0.5;
            events.push(event(if case % 3 == 0 { i / 2 } else { i }, t));
        }
        if case % 2 == 0 {
            events.reverse();
        }
        let p = AutoClipParams {
            gap: 20.,
            n: 1 + (case % 5) as i32,
            before: (case % 8) as f64,
            after: (case % 7) as f64,
            max_len: 5. + (case % 30) as f64,
        };
        assert_eq!(
            super::auto_clips(&events, &p, 1000.),
            reference(&events, &p, 1000.),
            "case {case}"
        );
    }
}
#[test]
#[ignore = "manual performance comparison"]
fn benchmark_split() {
    for count in [1000, 2000, 4000, 8000] {
        let events: Vec<_> = (0..count).map(|i| event(i, i as f64)).collect();
        let p = AutoClipParams {
            gap: 20.,
            n: 1,
            before: 0.,
            after: 0.,
            max_len: 1.,
        };
        let old = reference(&events, &p, count as f64);
        assert_eq!(old, super::auto_clips(&events, &p, count as f64));
        let measure = |f: &dyn Fn() -> Vec<Clip>| {
            let mut samples = Vec::new();
            for _ in 0..5 {
                let start = std::time::Instant::now();
                std::hint::black_box(f());
                samples.push(start.elapsed());
            }
            samples.sort();
            samples[2]
        };
        let old_time = measure(&|| reference(&events, &p, count as f64));
        let new_time = measure(&|| super::auto_clips(&events, &p, count as f64));
        println!("split {count}: old={old_time:?} new={new_time:?}");
    }
}
