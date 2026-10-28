mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{layout::Layout, matches::MatchTracker};
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
