mod common;
use aditor::{
    cv::Image,
    detect::Detector,
    events::EventTracker,
    live::{KillLimits, LiveKills},
};
#[test]
fn japanese_kill_reads_the_name_before_the_keyword() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mixtape");
    let detector = aditor::mixtape::MixtapeDetector::new(&p).unwrap();
    let read = |name: &str| {
        (
            aditor::cv::read_png(&root.join(format!("ja_{name}_banner.png")), false).unwrap(),
            aditor::cv::read_png(&root.join(format!("ja_{name}_spec.png")), false).unwrap(),
        )
    };
    let (banner, spec) = read("kill");
    let kill = detector.detect(&banner, &spec).unwrap().unwrap();
    assert_eq!(kill.kind.as_deref(), Some("kill"));
    assert_eq!(kill.hint.as_deref(), Some("plain"));
    // `XIAOYU-VOV` is ten glyphs; a signature this wide shows the name, not the keyword, was read.
    assert!(kill.name_sig.unwrap().width >= 60);
    let (banner, spec) = read("other");
    assert!(detector.detect(&banner, &spec).unwrap().is_none());
}
#[test]
fn respawns_survive_live_calibration_and_match_offline() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mixtape");
    for name in ["kill", "assist"] {
        let b = aditor::cv::read_png(&root.join(format!("{name}_banner.png")), false).unwrap();
        let s = aditor::cv::read_png(&root.join(format!("{name}_spec.png")), false).unwrap();
        let blank = Image::new(b.width, b.height, 3, vec![0; b.data.len()]).unwrap();
        let det = Detector::new(&p, 1., None, None).unwrap();
        let mut tracker = EventTracker::new(&p, None);
        let mut live = LiveKills::new(
            &p,
            KillLimits {
                calib_scan: 1.,
                learn_seconds: 1.,
                ..Default::default()
            },
        )
        .unwrap();
        for i in 0..32 {
            let t = i as f64 * 0.25;
            let b = if i < 8 || (20..28).contains(&i) {
                &b
            } else {
                &blank
            };
            tracker.feed(t, det.detect(b, &s).unwrap());
            live.feed(t, b, &s, None, None).unwrap();
        }
        let (events, spec) = tracker.finish();
        let offline = aditor::derive::derive(&events, &spec, &p);
        assert_eq!(offline.len(), 2);
        assert!(offline.iter().all(|e| e.counted));
        assert_eq!(
            serde_json::json!(live.finish().unwrap().0),
            serde_json::json!(offline)
        );
    }
}
