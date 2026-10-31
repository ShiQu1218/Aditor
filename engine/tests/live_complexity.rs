mod common;
use aditor::{
    models::Event,
    valorant_rounds::{round_highlights, Round},
};
fn reference(events: &[Event], rounds: &[Round]) -> Vec<Event> {
    let mut assigned = std::collections::HashSet::new();
    let mut out = vec![];
    for r in rounds {
        let mut kills: Vec<_> = events
            .iter()
            .filter(|e| {
                e.kind == "kill"
                    && !e.deleted
                    && e.counted_override.unwrap_or(e.counted)
                    && !assigned.contains(&e.id)
                    && r.start <= e.t
                    && e.t < r.end + 3.
            })
            .collect();
        kills.sort_by(|a, b| a.t.total_cmp(&b.t));
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

fn event(i: usize, t: f64) -> Event {
    serde_json::from_value(serde_json::json!({"id":format!("e{i}"), "t":t, "type":"kill", "score":1., "damage_line":false,
        "name_sig":null,"counted":true,"counted_reason":"first","source":"auto"})).unwrap()
}
#[test]
fn indexed_rounds_match_reference() {
    for case in 0..100 {
        let mut events: Vec<_> = (0..200)
            .map(|i| event(i / 2, ((i * 17 + case) % 200) as f64))
            .collect();
        events[case].deleted = true;
        let rounds: Vec<_> = (0..20)
            .map(|i| Round {
                start: ((i * 13 + case) % 180) as f64,
                end: ((i * 13 + case) % 180 + 15) as f64,
                winner: "ally".into(),
                ally: i,
                enemy: 0,
            })
            .collect();
        assert_eq!(
            round_highlights(&events, &rounds),
            reference(&events, &rounds)
        );
    }
}
#[test]
#[ignore = "manual performance comparison"]
fn benchmark_rounds() {
    for n in [1000, 2000, 4000, 8000] {
        let events: Vec<_> = (0..n).map(|i| event(i, i as f64)).collect();
        let rounds: Vec<_> = (0..n / 10)
            .map(|i| Round {
                start: (i * 10) as f64,
                end: (i * 10 + 7) as f64,
                winner: "ally".into(),
                ally: i,
                enemy: 0,
            })
            .collect();
        assert_eq!(
            round_highlights(&events, &rounds),
            reference(&events, &rounds)
        );
        let measure = |f: &dyn Fn() -> Vec<Event>| {
            let mut samples = vec![];
            for _ in 0..6 {
                let t = std::time::Instant::now();
                std::hint::black_box(f());
                samples.push(t.elapsed());
            }
            samples.remove(0);
            samples.sort();
            samples[2]
        };
        println!(
            "rounds {n}: old={:?} new={:?}",
            measure(&|| reference(&events, &rounds)),
            measure(&|| round_highlights(&events, &rounds))
        );
    }
}
