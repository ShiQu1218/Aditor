mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{
    cv::{self, Image, Interpolation},
    layout::Layout,
    scene::SceneMatcher,
};
use serde_json::json;
#[test]
fn all_scene_fixtures_match_full_and_lazy_python_scores() {
    let det = SceneMatcher::new(None).unwrap();
    for c in parity::cases()["scene"].as_array().unwrap() {
        let f = parity::screen(c["file"].as_str().unwrap());
        for full in [true, false] {
            let out = det.classify_frame(&f, Layout::default(), full).unwrap();
            let expected = &c[if full { "full" } else { "fast" }];
            let mut actual = json!(out);
            let mut expected = expected.clone();
            // Loading candidates now also check for a contradictory HUD; use frozen full scores for these extra checks.
            if !full {
                for key in out.scores.keys() {
                    if expected["scores"].get(key).is_none() {
                        expected["scores"][key] = c["full"]["scores"][key].clone();
                    }
                }
            }
            // The new objective variant may raise scores; frozen scenes must keep their classification.
            if let Some(score) = expected["scores"]
                .get("control_objectives")
                .and_then(|v| v.as_f64())
            {
                assert_eq!(out.scores["control_objectives"] >= 0.8, score >= 0.8);
                actual["scores"]
                    .as_object_mut()
                    .unwrap()
                    .remove("control_objectives");
                expected["scores"]
                    .as_object_mut()
                    .unwrap()
                    .remove("control_objectives");
            }
            parity::close(&actual, &expected);
        }
    }
}
#[test]
fn resolutions_blank_validation_and_color() {
    let det = SceneMatcher::new(None).unwrap();
    for (w, h) in [(640, 360), (1280, 720), (1916, 1080), (2560, 1440)] {
        for kind in ["pre_match", "lobby", "in_match_hud", "other"] {
            let c = parity::cases()["scene"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["full"]["kind"] == kind)
                .unwrap();
            let f = parity::screen(c["file"].as_str().unwrap());
            let f = cv::resize(&f, w, h, Interpolation::Linear).unwrap();
            let bgr = Image::new(w, h, 3, f.data.iter().flat_map(|v| [*v; 3]).collect()).unwrap();
            assert_eq!(
                det.classify_frame(&bgr, Layout::default(), false)
                    .unwrap()
                    .kind,
                kind
            );
        }
    }
    for value in [0, 8, 9, 127, 255] {
        let f = Image::new(640, 360, 1, vec![value; 640 * 360]).unwrap();
        let out = det.classify_frame(&f, Layout::default(), false).unwrap();
        assert_eq!(out.kind, "other");
        assert_eq!(out.blank, value <= 8);
    }
    for (w, h, c) in [(320, 180, 1), (640, 360, 4)] {
        let f = Image::new(w, h, c, vec![0; w * h * c]).unwrap();
        assert!(det.classify_frame(&f, Layout::default(), false).is_err());
    }
}

#[test]
fn loading_border_false_positives_cannot_split_a_visible_match() {
    let det = SceneMatcher::new(None).unwrap();
    let image = parity::screen("ranked_20261107_0815.png");
    for full in [true, false] {
        let scene = det.classify_frame(&image, Layout::default(), full).unwrap();
        assert!(scene.scores["ranked_chevron"] >= 0.75);
        assert!(scene.scores["wildcard_footer"] >= 0.75);
        assert_eq!(scene.kind, "in_match_hud");
        let mut tracker = aditor::matches::MatchTracker::new(1.).unwrap();
        tracker.feed(0., &scene).unwrap();
        // Even persistent map geometry must not end a match whose HUD remains visible.
        for t in 1..=10 {
            assert!(tracker.feed(f64::from(t), &scene).unwrap().is_empty());
        }
        tracker.finish(11.).unwrap();
        assert_eq!(json!(tracker.matches), json!([{ "start": 0., "end": 11. }]));
        assert!(tracker.events.iter().all(|e| e.reason != "next_match"));
    }
}

#[test]
fn masks_stretched_scenes_and_whole_frame_blank() {
    let det = SceneMatcher::new(None).unwrap();
    let mut opening = parity::screen("clip1_0004.png");
    for y in 20..85 {
        opening.data[y * 640..y * 640 + 130].fill(127);
    }
    for y in 302..340 {
        opening.data[y * 640 + 200..y * 640 + 460].fill(255);
    }
    assert_eq!(
        det.classify_frame(&opening, Layout::default(), false)
            .unwrap()
            .kind,
        "pre_match"
    );
    let mut dark = Image::new(640, 360, 1, vec![0; 640 * 360]).unwrap();
    dark.data[180 * 640 + 320] = 255;
    assert!(
        !det.classify_frame(&dark, Layout { squash: 0.75 }, false)
            .unwrap()
            .blank
    );
    let mut wrong = 0;
    let cases = parity::cases()["scene"].as_array().unwrap();
    for c in cases {
        let f = parity::screen(c["file"].as_str().unwrap());
        let mut canvas = Image::new(640, 480, 1, vec![0; 640 * 480]).unwrap();
        for (rect, anchor) in aditor::layout::SCENE_ROIS {
            let [x, y, w, h] = rect.map(|v| v as usize / 3);
            let shift = match anchor {
                aditor::layout::Anchor::Top => 0,
                aditor::layout::Anchor::Center => 60,
                aditor::layout::Anchor::Bottom => 120,
            };
            for yy in 0..h {
                canvas.data[(y + shift + yy) * 640 + x..(y + shift + yy) * 640 + x + w]
                    .copy_from_slice(&f.data[(y + yy) * 640 + x..(y + yy) * 640 + x + w]);
            }
        }
        let frame = cv::resize(&canvas, 640, 360, Interpolation::Area).unwrap();
        let got = det
            .classify_frame(&frame, Layout { squash: 0.75 }, false)
            .unwrap();
        if got.kind != c["full"]["kind"].as_str().unwrap() {
            assert_eq!(got.kind, "other");
            wrong += 1;
        }
    }
    assert!(wrong <= cases.len() / 20);
}
