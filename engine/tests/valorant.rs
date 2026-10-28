mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{cv::Image, valorant::*};
use serde_json::{json, Value};
fn row(id: &Value) -> FeedRow {
    let r = &parity::cases()["rows"][id.as_str().unwrap()];
    FeedRow {
        slot: r["slot"].as_u64().unwrap() as usize,
        kind: r["type"].as_str().unwrap().into(),
        signature: serde_json::from_value(r["signature"].clone()).unwrap(),
        confirmed: r["confirmed"].as_bool().unwrap(),
        identity: serde_json::from_value(r["identity"].clone()).unwrap(),
    }
}
fn profile() -> ValorantProfile {
    load_valorant_profile(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/valorant/icons"),
    )
    .unwrap()
}
#[test]
fn python_feed_detection_and_tracking_cases() {
    let det = FeedDetector::new(&profile());
    for c in parity::cases()["detections"].as_array().unwrap() {
        let rows = det
            .observations(&parity::image(c["frame"].as_str().unwrap()))
            .unwrap();
        let expected: Vec<_> = c["rows"].as_array().unwrap().iter().map(row).collect();
        assert_eq!(rows.len(), expected.len(), "{c}");
        for (a, b) in rows.iter().zip(expected) {
            assert_eq!(
                (a.slot, &a.kind, a.confirmed),
                (b.slot, &b.kind, b.confirmed),
                "{c}"
            );
            parity::close(&json!(a.signature), &json!(b.signature));
            parity::close(&json!(a.identity), &json!(b.identity));
        }
    }
    for trace in parity::cases()["feed_traces"].as_array().unwrap() {
        let mut tr = FeedTracker::default();
        for c in trace.as_array().unwrap() {
            let rows: Vec<_> = c["rows"].as_array().unwrap().iter().map(row).collect();
            parity::close(&json!(tr.feed(c["t"].as_f64().unwrap(), &rows)), &c["new"]);
            parity::close(&json!(tr.events), &c["events"]);
        }
    }
}
#[test]
fn restore_validates_profile_and_covers_every_aspect() {
    let p = profile();
    assert_eq!(p.capture_banner, capture_rect(BANNER_REF, true));
    assert_eq!(p.capture_spec, capture_rect(SPEC_REF, false));
    let b = Image::new(
        p.capture_banner[2] as usize,
        256,
        3,
        vec![60; p.capture_banner[2] as usize * 256 * 3],
    )
    .unwrap();
    let s = Image::new(
        p.capture_spec[2] as usize,
        64,
        3,
        vec![60; p.capture_spec[2] as usize * 64 * 3],
    )
    .unwrap();
    for (_, a) in aditor::layout::SUPPORTED_ASPECTS {
        let p = p.with_layout(aditor::layout::Layout::from_ratio(a));
        let (b, s) = p.restore(&b, &s).unwrap();
        assert_eq!((b.width, b.height, s.width, s.height), (600, 256, 460, 64));
    }
    let temp = common::TempDir::new();
    std::fs::write(
        temp.0.join("profile.json"),
        r#"{"templates_version":"v","capture_rois":{"banner":[1,2,3,4],"spec":[1,2,3,4]}}"#,
    )
    .unwrap();
    assert!(load_valorant_profile(&temp.0).is_err());
}
#[test]
fn reanalysis_preserves_edits_then_rebuilds_highlights() {
    for c in parity::cases()["merges"].as_array().unwrap() {
        let (events, lost) = merge_events(
            &serde_json::from_value::<Vec<_>>(c["base"].clone()).unwrap(),
            &serde_json::from_value::<Vec<_>>(c["detected"].clone()).unwrap(),
            &serde_json::from_value::<Vec<_>>(c["rounds"].clone()).unwrap(),
        );
        parity::close(&json!(events), &c["events"]);
        parity::close(&json!(lost), &c["lost"]);
    }
}

#[test]
fn stretched_and_letterboxed_restore_pixels_match_python() {
    for c in parity::cases()["restores"].as_array().unwrap() {
        let p = profile().with_layout(aditor::layout::Layout {
            squash: c["squash"].as_f64().unwrap(),
        });
        let (b, s) = p
            .restore(
                &parity::image(c["banner"].as_str().unwrap()),
                &parity::image(c["spec"].as_str().unwrap()),
            )
            .unwrap();
        assert_eq!(b, parity::image(c["expected_banner"].as_str().unwrap()));
        assert_eq!(s, parity::image(c["expected_spec"].as_str().unwrap()));
    }
}
