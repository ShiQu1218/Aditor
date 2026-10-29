mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{layout::Layout, matches::MatchTracker, scene::SceneFrame};
use serde_json::json;
#[test]
fn all_python_match_tracker_traces() {
    for (i, c) in parity::cases()["match_traces"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let mut tr = MatchTracker::new(c["period"].as_f64().unwrap()).unwrap();
        for call in c["calls"].as_array().unwrap() {
            let t = parity::number(&call["t"]);
            let out = if call["op"] == "feed" {
                tr.feed(t, &parity::scene(&call["scene"]))
            } else {
                tr.finish(t)
            };
            if let Some(error) = call["error"].as_str() {
                assert_eq!(out.unwrap_err().to_string(), error, "trace {i}");
            } else {
                parity::close(&json!(out.unwrap()), &call["events"]);
                if call.get("matches").is_some() {
                    parity::close(&json!(tr.matches), &call["matches"]);
                }
            }
        }
    }
}
#[test]
fn invalid_fps_before_probe_and_real_decoder_grid() {
    for fps in [0., -1., f64::NAN, f64::INFINITY] {
        assert_eq!(
            aditor::matches::analyze_matches("absent", fps, false, false, None, None)
                .unwrap_err()
                .to_string(),
            "fps must be a finite positive number"
        );
        assert!(MatchTracker::new(fps).is_err());
    }
    let temp = common::TempDir::new();
    for (offset, vfr) in [(0., false), (5., false), (0., true)] {
        let path = common::make_video(
            &temp.0,
            &format!("{offset}-{vfr}.mp4"),
            2.,
            common::VideoOptions {
                start_time: offset,
                vfr,
                ..Default::default()
            },
        );
        let frames: Vec<_> =
            aditor::matches::VideoFrames::new(path.to_str().unwrap(), 1., false, "h264")
                .map(Result::unwrap)
                .collect();
        assert_eq!(
            frames.iter().map(|(t, _)| *t).collect::<Vec<_>>(),
            vec![0., 1.]
        );
        let doc = aditor::matches::analyze_matches(
            path.to_str().unwrap(),
            1.,
            true,
            false,
            Some(Layout::default()),
            None,
        )
        .unwrap();
        assert_eq!(doc["matches"], json!([]));
        assert_eq!(doc["timeline"].as_array().unwrap().len(), 2);
    }
}
#[test]
#[ignore = "slow: requires ADITOR_MATCH_DIR recordings"]
fn recording_acceptance() {
    let dir = std::env::var("ADITOR_MATCH_DIR").expect("ADITOR_MATCH_DIR");
    let truth: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/matches/truth.json")).unwrap();
    for (name, c) in truth.as_object().unwrap() {
        let path = std::path::Path::new(&dir).join(name);
        let got =
            aditor::matches::analyze_matches(path.to_str().unwrap(), 1., false, true, None, None)
                .unwrap();
        let actual = got["matches"].as_array().unwrap();
        let wanted = c["matches"].as_array().unwrap();
        assert_eq!(actual.len(), wanted.len(), "{name}");
        for (a, b) in actual.iter().zip(wanted) {
            for key in ["start", "end"] {
                assert!(
                    (a[key].as_f64().unwrap() - b[key].as_f64().unwrap()).abs() <= 5.,
                    "{name}: {a} != {b}"
                );
            }
        }
    }
}
fn frame(kind: &'static str, chevron: f64) -> SceneFrame {
    let mut scene = SceneFrame::new(kind);
    scene.scores.insert("mode_chevron".into(), chevron);
    scene
}
/// Feed one sample per second: `opening` map/legend-select seconds, `blind` unrecognized seconds, then HUD.
fn opening_trace(tracker: MatchTracker, opening: u32, blind: u32) -> Vec<(f64, String)> {
    let mut tracker = tracker;
    let mut t = 0.;
    for _ in 0..opening {
        tracker.feed(t, &frame("other", 0.99)).unwrap();
        t += 1.;
    }
    for _ in 0..blind {
        tracker.feed(t, &frame("other", 0.2)).unwrap();
        t += 1.;
    }
    for _ in 0..10 {
        tracker.feed(t, &frame("in_match_hud", 0.2)).unwrap();
        t += 1.;
    }
    tracker.finish(t).unwrap();
    tracker
        .events
        .iter()
        .filter(|e| e.r#type == "match_start")
        .map(|e| (e.t, e.reason.clone()))
        .collect()
}
#[test]
fn offline_hud_recovery_starts_at_the_opening_screen() {
    let offline = MatchTracker::new(1.).unwrap().backdate_openings();
    assert_eq!(
        opening_trace(offline, 3, 40),
        [(0., "opening_screen".to_owned())]
    );
    // Live keeps the HUD start because footage before the match is already pruned.
    let live = MatchTracker::new(1.).unwrap();
    assert_eq!(opening_trace(live, 3, 40), [(43., "hud_resume".to_owned())]);
}
#[test]
fn stale_opening_screen_does_not_backdate() {
    let offline = MatchTracker::new(1.).unwrap().backdate_openings();
    assert_eq!(
        opening_trace(offline, 3, 200),
        [(203., "hud_resume".to_owned())]
    );
}
#[test]
fn lobby_clears_the_opening_screen() {
    let mut tracker = MatchTracker::new(1.).unwrap().backdate_openings();
    tracker.feed(0., &frame("other", 0.99)).unwrap();
    tracker.feed(1., &frame("lobby", 0.2)).unwrap();
    for t in 2..8 {
        tracker.feed(t as f64, &frame("in_match_hud", 0.2)).unwrap();
    }
    assert_eq!(tracker.events[0].t, 2.);
    assert_eq!(tracker.events[0].reason, "hud_resume");
}
/// Feed `frames` one second apart from t=0 into an offline tracker, then HUD until a match starts; returns the first start.
fn first_start(frames: &[SceneFrame]) -> (f64, String) {
    let mut tracker = MatchTracker::new(1.).unwrap().backdate_openings();
    let mut t = 0.;
    for scene in frames {
        tracker.feed(t, scene).unwrap();
        t += 1.;
    }
    while tracker.events.iter().all(|e| e.r#type != "match_start") {
        tracker.feed(t, &frame("in_match_hud", 0.2)).unwrap();
        t += 1.;
    }
    let start = tracker
        .events
        .iter()
        .find(|e| e.r#type == "match_start")
        .unwrap();
    (start.t, start.reason.clone())
}
#[test]
fn opening_hint_threshold_and_ranked_card() {
    let mut ranked = SceneFrame::new("other");
    ranked.scores.insert("mode_chevron".into(), 0.3);
    ranked.scores.insert("ranked_chevron".into(), 0.75);
    assert!(ranked.opening_hint());
    assert!(!frame("other", 0.749).opening_hint());
    assert!(!frame("in_match_hud", 0.99).opening_hint());
    let mut summary = frame("other", 0.99);
    summary.match_context = true;
    assert!(!summary.opening_hint());
}
#[test]
fn blank_and_summary_screens_do_not_backdate() {
    let mut blank = frame("other", 0.2);
    blank.blank = true;
    let mut frames = vec![frame("other", 0.99)];
    frames.extend(std::iter::repeat_n(blank, 61));
    assert_eq!(first_start(&frames).1, "hud_resume");
    let mut summary = frame("other", 0.99);
    summary.match_context = true;
    let frames = [frame("other", 0.2), frame("other", 0.2), summary];
    // Not within the initial 10 s recovery window, so the summary screen must not count as an opening.
    let mut later = vec![frame("other", 0.2); 20];
    later.extend(frames);
    assert_eq!(first_start(&later).1, "hud_resume");
}
#[test]
fn sampling_gap_clears_the_opening_screen() {
    let mut tracker = MatchTracker::new(1.).unwrap().backdate_openings();
    tracker.feed(0., &frame("other", 0.99)).unwrap();
    tracker.feed(20., &frame("other", 0.2)).unwrap();
    for t in 21..30 {
        tracker.feed(t as f64, &frame("in_match_hud", 0.2)).unwrap();
    }
    assert_eq!(tracker.events[0].reason, "hud_resume");
    assert_eq!(tracker.events[0].t, 21.);
}
#[test]
fn opening_screen_is_used_once_and_loading_screen_wins() {
    // The loading screen path keeps its own start; a hint seen before it is dropped.
    let pre = SceneFrame::new("pre_match");
    let (t, reason) = first_start(&[frame("other", 0.2), frame("other", 0.99), pre]);
    assert_eq!((t, reason.as_str()), (2., "opening_confirmed"));
    // After a match starts from a hint, the next HUD recovery needs a new hint.
    let mut tracker = MatchTracker::new(1.).unwrap().backdate_openings();
    let mut t = 0.;
    let mut feed = |tracker: &mut MatchTracker, scene: SceneFrame, n: u32| {
        for _ in 0..n {
            tracker.feed(t, &scene).unwrap();
            t += 1.;
        }
    };
    feed(&mut tracker, frame("other", 0.2), 15);
    feed(&mut tracker, frame("other", 0.99), 1);
    feed(&mut tracker, frame("in_match_hud", 0.2), 5);
    feed(&mut tracker, frame("lobby", 0.2), 40);
    feed(&mut tracker, frame("other", 0.2), 5);
    feed(&mut tracker, frame("in_match_hud", 0.2), 5);
    let starts: Vec<_> = tracker
        .events
        .iter()
        .filter(|e| e.r#type == "match_start")
        .map(|e| (e.t, e.reason.as_str()))
        .collect();
    assert_eq!(starts, [(15., "opening_screen"), (66., "hud_resume")]);
}
