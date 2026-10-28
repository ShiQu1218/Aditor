use super::*;
use crate::{cv::Image, detect::Pending, icon_detect::IconFrame};

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
#[test]
fn late_templates_replay_earlier_false_banners_without_losing_feed_events() {
    let p = crate::profile::load_profile(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/icons"),
    )
    .unwrap();
    let mut seg = Segment::new(0., 960., true, 960.);
    seg.own_from = 0.;
    let mut learning = Learning::new(&[seg.clone()], 960.);
    learning.finish(0).unwrap();
    assert!(learning.late());
    let Prepared::Pending(hit) = pending(true) else {
        unreachable!()
    };
    for t in [914., 922., 931.] {
        learning.late_cols[0].knock.add(t, hit.ink.clone());
    }
    let mut state = State::new(vec![seg], vec![], vec![], None, Some(learning));
    assert!(state.learned().is_none());
    let det = Detector::new(&p, 1., None, None).unwrap();
    let mut tracker = EventTracker::new(&p, None);
    let mut log = vec![];
    for (t, real) in [(4., false), (4.25, false), (14., true), (14.25, true)] {
        let r = pending(real);
        tracker.feed(t, det.resolve(&r).unwrap());
        log.push((t, r));
    }
    state.segs[0].events = tracker.finish().0;
    assert_eq!(state.segs[0].events.len(), 2);
    let mut feed_event = state.segs[0].events[0].clone();
    feed_event.kind = "kill".into();
    feed_event.t = 50.;
    state.segs[0].feed_events.push(feed_event.clone());
    state.replays[0] = Some(log);
    finalize(&mut state, &p, 1.).unwrap();
    assert!(state.learned().unwrap().knock.is_some());
    assert_eq!(state.segs[0].events.len(), 1);
    assert_eq!(state.segs[0].events[0].t, 14.);
    assert_eq!(state.combined().0.last(), Some(&feed_event));
}
#[test]
fn all_segments_must_finish_the_initial_window_before_replaying() {
    let segs = vec![
        Segment::new(0., 30., false, 60.),
        Segment::new(30., 60., true, 60.),
    ];
    let learning = Learning::new(&segs, 60.);
    let mut state = State::new(segs, vec![], vec![], None, Some(learning));
    let p = crate::profile::load_profile(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/icons"),
    )
    .unwrap();
    let mut det = Detector::new(&p, 1., None, None).unwrap();
    let mut tracker = EventTracker::new(&p, None);
    let mut buf = Some(vec![(0., pending(true)), (0.25, pending(true))]);
    state.learning.as_mut().unwrap().finish(0).unwrap();
    assert!(!flush(&state, &mut det, &mut tracker, &mut buf).unwrap());
    assert_eq!(buf.as_ref().unwrap().len(), 2);
    state.learning.as_mut().unwrap().finish(1).unwrap();
    assert!(flush(&state, &mut det, &mut tracker, &mut buf).unwrap());
    assert!(buf.is_none());
    assert_eq!(tracker.finish().0.len(), 1);
}
