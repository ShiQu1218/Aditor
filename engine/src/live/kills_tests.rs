use super::*;
use crate::{detect::Pending, icon_detect::IconFrame};
fn pending(real: bool) -> Prepared {
    Prepared::Pending(Pending {
        kind: "knock".into(),
        f: IconFrame {
            plus_x: 4,
            chev: 0.9,
            name_color: 100,
            ..Default::default()
        },
        ink: Image::new(
            4,
            4,
            1,
            (0..16)
                .map(|i| if real && i % 3 == 0 { 1. } else { 0. })
                .collect(),
        )
        .unwrap(),
        sig: None,
        spectating: false,
    })
}
fn profile() -> Profile {
    crate::profile::load_profile(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/icons"),
    )
    .unwrap()
}
fn learning(limits: KillLimits) -> LiveKills {
    let mut k = LiveKills::new(&profile(), limits).unwrap();
    k.calibrated().unwrap();
    k
}
#[test]
fn late_learning_replays_provisional_false_banners_and_preserves_real_knocks() {
    let mut k = learning(KillLimits {
        learn_seconds: 10.,
        ..Default::default()
    });
    for (t, real) in [(4., false), (4.25, false), (14., true), (14.25, true)] {
        k.route(t, None, pending(real), None).unwrap();
    }
    assert_eq!(
        k.snapshot().0.iter().map(|e| e.t).collect::<Vec<_>>(),
        vec![4., 14.]
    );
    let Prepared::Pending(hit) = pending(true) else {
        unreachable!()
    };
    for t in [14., 22., 31.] {
        k.late_col.as_mut().unwrap().knock.add(t, hit.ink.clone());
    }
    k.settle().unwrap();
    assert!(k.keywords.as_ref().unwrap().knock.is_some());
    assert_eq!(
        k.snapshot().0.iter().map(|e| e.t).collect::<Vec<_>>(),
        vec![14.]
    );
    for (t, real) in [
        (22., true),
        (22.25, true),
        (31., true),
        (31.25, true),
        (41., true),
        (41.25, true),
        (50., false),
        (50.25, false),
    ] {
        k.route(t, None, pending(real), None).unwrap();
    }
    let actual = k.finish().unwrap().0;
    assert_eq!(
        actual.iter().map(|e| e.t).collect::<Vec<_>>(),
        vec![14., 22., 31., 41.]
    );
    let mut offline = EventTracker::new(&profile(), None);
    for (t, real) in [
        (4., false),
        (4.25, false),
        (14., true),
        (14.25, true),
        (22., true),
        (22.25, true),
        (31., true),
        (31.25, true),
        (41., true),
        (41.25, true),
        (50., false),
        (50.25, false),
    ] {
        offline.feed(
            t,
            k.detector
                .as_ref()
                .unwrap()
                .resolve(&pending(real))
                .unwrap(),
        );
    }
    let (events, spec) = offline.finish();
    assert_eq!(actual, crate::derive::derive(&events, &spec, &profile()));
    assert!(k.degraded.is_empty());
}
#[test]
fn late_replay_and_pending_caps_degrade_without_losing_events() {
    let mut k = learning(KillLimits {
        learn_seconds: 10.,
        late_bytes: 1,
        ..Default::default()
    });
    k.route(4., None, pending(true), None).unwrap();
    k.route(4.25, None, pending(true), None).unwrap();
    k.route(14., None, pending(true), None).unwrap();
    assert!(k.degraded.iter().any(|s| s == "late_learn_cap"));
    assert!(k.logs.iter().any(|s| s.contains("Extended learning")));
    assert!(k.replay.is_none());
    assert!(!k.finish().unwrap().0.is_empty());
    let mut k = learning(KillLimits {
        pending_bytes: 0,
        ..Default::default()
    });
    k.route(0., None, pending(true), None).unwrap();
    assert_eq!(k.degraded, vec!["pending_buffer_cap"]);
    assert_eq!(k.late_from, 0.25);
    assert!(k.finish().is_ok());
}
