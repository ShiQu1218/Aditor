mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{
    control_feed::ControlFeed,
    cv::Image,
    live::{KillLimits, LiveKills},
};
use serde_json::{json, Value};
fn sig(id: &Value) -> Image<f32> {
    let s = &parity::cases()["control_rows"][id.as_str().unwrap()];
    let (w, h) = (
        s["width"].as_u64().unwrap() as usize,
        s["height"].as_u64().unwrap() as usize,
    );
    let mut data = vec![0.; w * h];
    for p in s["nonzero"].as_array().unwrap() {
        data[p[0].as_u64().unwrap() as usize] = p[1].as_f64().unwrap() as f32;
    }
    Image::new(w, h, 1, data).unwrap()
}
fn close_live(mut actual: Value, mut expected: Value, control: bool) {
    if control {
        // Grayscale glyph normalization changes confidence, not event identity/timing.
        for doc in [&mut actual, &mut expected] {
            for event in doc["events"].as_array_mut().unwrap() {
                assert!((0.6..=1.).contains(&event["score"].as_f64().unwrap()));
                event.as_object_mut().unwrap().remove("score");
            }
        }
    }
    parity::close(&actual, &expected);
}
#[test]
fn fading_moving_rows_and_respawn_trace() {
    let p = common::profile();
    let mut c = ControlFeed::new(&p).unwrap();
    for call in parity::cases()["control_trace"].as_array().unwrap() {
        let rows = call["rows"].as_array().unwrap().iter().map(sig).collect();
        c.feed_rows(call["t"].as_f64().unwrap(), rows).unwrap();
    }
    assert_eq!(
        c.events.iter().map(|e| e.t).collect::<Vec<_>>(),
        vec![1807.75, 1862.]
    );
}
#[test]
fn live_control_and_mixtape_calibration_match_python() {
    let p = common::profile();
    for c in parity::cases()["live_kills"].as_array().unwrap() {
        let control = c["calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|call| call["killfeed"].is_string());
        let mut live = LiveKills::new(&p, KillLimits::default()).unwrap();
        for call in c["calls"].as_array().unwrap() {
            let b = parity::image(call["banner"].as_str().unwrap());
            let s = parity::image(call["spec"].as_str().unwrap());
            let f = call["killfeed"].as_str().map(parity::image);
            live.feed(call["t"].as_f64().unwrap(), &b, &s, f.as_ref(), None)
                .unwrap();
            let (e, s) = live.snapshot();
            close_live(
                json!({"events":e,"spectating":s}),
                call["snapshot"].clone(),
                control,
            );
        }
        let (e, s) = live.finish().unwrap();
        close_live(
            json!({"events":e,"spectating":s}),
            c["final"].clone(),
            control,
        );
        assert_eq!(json!(live.degraded), c["degraded"]);
        assert_eq!(json!(live.h_scale), c["scale"]);
    }
}
#[test]
fn lobby_disarms_control() {
    let p = common::profile();
    let mut c = ControlFeed::new(&p).unwrap();
    let calls = parity::cases()["live_kills"][0]["calls"]
        .as_array()
        .unwrap();
    let f = parity::image(calls[0]["killfeed"].as_str().unwrap());
    let s = parity::image(calls[0]["spec"].as_str().unwrap());
    c.feed(0., Some(&f), &s, None).unwrap();
    assert!(c.active);
    let mut zero = f.clone();
    zero.data.fill(0);
    let lobby = parity::cases()["scene"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["full"]["kind"] == "lobby")
        .unwrap();
    let thumb = parity::screen(lobby["file"].as_str().unwrap());
    c.feed(1., Some(&zero), &s, Some(&thumb)).unwrap();
    assert!(!c.active);
}

#[test]
fn battle_royale_counters_reject_compass_false_positive_and_disarm_control() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    let control = aditor::cv::read_png(&root.join("1745_0_feed.png"), false).unwrap();
    let spec = aditor::cv::read_png(&root.join("1745_0_spec.png"), false).unwrap();
    for name in ["br_271_25_hud.png", "br_506_hud.png"] {
        let hud = aditor::cv::read_png(&root.join(name), false).unwrap();
        let br = hud.border(0, 420 - hud.height, 0, 0, 0);
        let mut c = ControlFeed::new(&p).unwrap();
        for t in [0., 0.25, 0.5, 0.75] {
            c.feed(t, Some(&br), &spec, None).unwrap();
            assert!(!c.active, "{name} at {t}");
        }
        c.feed(1., Some(&control), &spec, None).unwrap();
        assert!(c.active);
        c.feed(1.25, Some(&br), &spec, None).unwrap();
        assert!(!c.active, "{name} must disarm an already active detector");
        c.feed(1.5, Some(&control), &spec, None).unwrap();
        assert!(c.active);
        assert!(c.events.is_empty());
    }
}

#[test]
fn inventory_false_positive_cannot_arm_control_with_scene_evidence() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    let hud = aditor::cv::read_png(&root.join("br_inventory_236_hud.png"), false).unwrap();
    let feed = hud.border(0, 420 - hud.height, 0, 0, 0);
    let thumb = aditor::cv::read_png(&root.join("br_inventory_236_thumb.png"), true).unwrap();
    let spec = aditor::cv::read_png(&root.join("1745_0_spec.png"), false).unwrap();
    let mut c = ControlFeed::new(&p).unwrap();
    c.feed(0., Some(&feed), &spec, Some(&thumb)).unwrap();
    assert!(!c.active);
    let control = aditor::cv::read_png(&root.join("1745_0_feed.png"), false).unwrap();
    let thumb = parity::screen("control_1745.png");
    c.feed(0.25, Some(&control), &spec, Some(&thumb)).unwrap();
    assert!(c.active);
}

#[test]
fn japanese_control_blue_names_and_gunrun_counter() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    let read = |mode: &str, roi: &str| {
        aditor::cv::read_png(&root.join(format!("ja_{mode}_{roi}.png")), false).unwrap()
    };
    let feed = read("control", "feed");
    let spec = read("control", "spec");
    let mut c = ControlFeed::new(&p).unwrap();
    assert_eq!(c.rows(&feed, &spec).unwrap().len(), 2);
    c.feed(0., Some(&feed), &spec, None).unwrap();
    c.feed(0.25, Some(&feed), &spec, None).unwrap();
    assert!(c.active);
    assert_eq!(c.events.len(), 2);
    let gunrun = read("gunrun", "feed");
    let spec = read("gunrun", "spec");
    c.feed(0.5, Some(&gunrun), &spec, None).unwrap();
    assert!(!c.active);
    let mut c = ControlFeed::new(&p).unwrap();
    c.feed(0., Some(&gunrun), &spec, None).unwrap();
    assert!(!c.active);
}

#[test]
fn japanese_control_muted_pink_player_name() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    let feed = aditor::cv::read_png(&root.join("ja_muted_feed.png"), false).unwrap();
    let spec = aditor::cv::read_png(&root.join("ja_muted_spec.png"), false).unwrap();
    let mut c = ControlFeed::new(&p).unwrap();
    assert_eq!(c.rows(&feed, &spec).unwrap().len(), 1);
    c.feed(0., Some(&feed), &spec, None).unwrap();
    c.feed(0.25, Some(&feed), &spec, None).unwrap();
    assert!(c.active);
    assert_eq!(c.events.len(), 1);
    let banner = Image::new(800, 180, 3, vec![0; 800 * 180 * 3]).unwrap();
    let mut live = LiveKills::new(&p, KillLimits::default()).unwrap();
    for t in [0., 0.25] {
        live.feed(t, &banner, &spec, Some(&feed), None).unwrap();
    }
    assert_eq!(live.snapshot().0.len(), 1);
    assert_eq!(live.finish().unwrap().0.len(), 1);
}

#[test]
fn japanese_control_yellow_player_name_counts_only_the_local_players_kill() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    let feed = aditor::cv::read_png(&root.join("ja_yellow_feed.png"), false).unwrap();
    let spec = aditor::cv::read_png(&root.join("ja_yellow_spec.png"), false).unwrap();
    let mut c = ControlFeed::new(&p).unwrap();
    assert_eq!(c.rows(&feed, &spec).unwrap().len(), 1);
    let banner = Image::new(800, 180, 3, vec![0; 800 * 180 * 3]).unwrap();
    let mut live = LiveKills::new(&p, KillLimits::default()).unwrap();
    for t in [0., 0.25, 0.5] {
        c.feed(t, Some(&feed), &spec, None).unwrap();
        live.feed(t, &banner, &spec, Some(&feed), None).unwrap();
    }
    assert!(c.active);
    assert_eq!(c.events.len(), 1);
    assert_eq!(live.finish().unwrap().0.len(), 1);

    let notice = aditor::cv::read_png(&root.join("ja_yellow_notice_feed.png"), false).unwrap();
    assert_eq!(
        ControlFeed::new(&p)
            .unwrap()
            .rows(&notice, &spec)
            .unwrap()
            .len(),
        1
    );

    let name = aditor::cv::gray(&feed.crop(610, 150, 100, 28).unwrap()).unwrap();
    for binary in [false, true] {
        let mut changed = feed.clone();
        for y in 0..name.height {
            for x in 0..name.width {
                let value = name.data[y * name.width + x];
                let value = if binary {
                    u8::from(value >= 170) * 255
                } else {
                    value
                };
                let i = ((y + 150) * changed.width + x + 610) * 3;
                changed.data[i..i + 3].fill(value);
            }
        }
        assert_eq!(
            ControlFeed::new(&p)
                .unwrap()
                .rows(&changed, &spec)
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn control_feed_and_hud_work_without_any_color_channels() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    let monochrome = |im: &Image<u8>| {
        let gray = aditor::cv::gray(im).unwrap();
        Image::new(
            gray.width,
            gray.height,
            3,
            gray.data.into_iter().flat_map(|v| [v; 3]).collect(),
        )
        .unwrap()
    };
    for (name, expected) in [
        ("1807_75", 1),
        ("ja_control", 2),
        ("ja_muted", 1),
        ("ja_yellow", 1),
    ] {
        let feed = aditor::cv::read_png(&root.join(format!("{name}_feed.png")), false).unwrap();
        let spec = aditor::cv::read_png(&root.join(format!("{name}_spec.png")), false).unwrap();
        assert_eq!(
            ControlFeed::new(&p)
                .unwrap()
                .rows(&monochrome(&feed), &monochrome(&spec))
                .unwrap()
                .len(),
            expected,
            "{name}"
        );
    }
}

#[test]
fn moving_short_victim_on_bright_background_stays_one_kill() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    let spec = aditor::cv::read_png(&root.join("ja_yellow_spec.png"), false).unwrap();
    let mut c = ControlFeed::new(&p).unwrap();
    for (i, name) in ["early", "early", "late", "late"].into_iter().enumerate() {
        let row =
            aditor::cv::read_png(&root.join(format!("ja_short_victim_{name}.png")), false).unwrap();
        let feed = row.border(148, 420 - 148 - row.height, 0, 0, 0);
        let rows = c.rows(&feed, &spec).unwrap();
        assert_eq!(rows.len(), 1);
        c.feed_rows(i as f64 * 0.25, rows).unwrap();
    }
    assert_eq!(c.events.len(), 1);
}

#[test]
fn faint_melee_name_is_recognized_in_color_and_monochrome() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    let row = aditor::cv::read_png(&root.join("ja_melee_row.png"), false).unwrap();
    let spec = aditor::cv::read_png(&root.join("ja_melee_spec.png"), false).unwrap();
    let feed = row.border(148, 420 - 148 - row.height, 0, 0, 0);
    for grayscale in [false, true] {
        let feed = if grayscale {
            let gray = aditor::cv::gray(&feed).unwrap();
            Image::new(
                gray.width,
                gray.height,
                3,
                gray.data.into_iter().flat_map(|v| [v; 3]).collect(),
            )
            .unwrap()
        } else {
            feed.clone()
        };
        assert_eq!(
            ControlFeed::new(&p)
                .unwrap()
                .rows(&feed, &spec)
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn system_messages_and_self_kills_are_not_control_kills() {
    let p = common::profile();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    let spec = aditor::cv::read_png(&root.join("ja_yellow_spec.png"), false).unwrap();
    let positive = aditor::cv::read_png(&root.join("ja_yellow_feed.png"), false)
        .unwrap()
        .crop(0, 148, 1070, 32)
        .unwrap();
    let positive = positive.border(148, 420 - 148 - positive.height, 0, 0, 0);
    assert_eq!(
        ControlFeed::new(&p)
            .unwrap()
            .rows(&positive, &spec)
            .unwrap()
            .len(),
        1
    );
    let other = aditor::cv::read_png(&root.join("other_victim_row.png"), false).unwrap();
    let other = other.border(148, 420 - 148 - other.height, 0, 0, 0);
    assert_eq!(
        ControlFeed::new(&p)
            .unwrap()
            .rows(&other, &spec)
            .unwrap()
            .len(),
        1
    );
    for name in ["notice_leader_en", "notice_ping_en", "self_victim_row"] {
        let row = aditor::cv::read_png(&root.join(format!("{name}.png")), false).unwrap();
        let feed = row.border(148, 420 - 148 - row.height, 0, 0, 0);
        assert!(
            ControlFeed::new(&p)
                .unwrap()
                .rows(&feed, &spec)
                .unwrap()
                .is_empty(),
            "{name}"
        );
    }
}

#[test]
fn hud_lines_are_not_player_names_and_do_not_exceed_search_dimensions() {
    let p = common::profile();
    let feed = Image::new(1070, 420, 3, vec![0; 1070 * 420 * 3]).unwrap();
    for solid in [true, false] {
        let mut spec = Image::new(480, 118, 3, vec![0; 480 * 118 * 3]).unwrap();
        for y in 20..22 {
            for x in 112..360 {
                if solid || (x - 112) % 31 == 0 || x == 359 {
                    let i = (y * spec.width + x) * 3;
                    spec.data[i..i + 3].fill(255);
                }
            }
        }
        assert!(ControlFeed::new(&p)
            .unwrap()
            .rows(&feed, &spec)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn fading_pink_feed_keeps_one_kill_then_counts_the_next_victim() {
    let p = common::profile();
    for (name, expected) in [
        ("pink_trace", vec![345., 359.25]),
        ("pink_late_trace", vec![657.5, 673., 681.5]),
    ] {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/control_feed")
            .join(name);
        let trace: Value =
            serde_json::from_slice(&std::fs::read(root.join("trace.json")).unwrap()).unwrap();
        let mut c = ControlFeed::new(&p).unwrap();
        for call in trace.as_array().unwrap() {
            let rows = call[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| {
                    let mut sig = aditor::cv::read_png(&root.join(name.as_str().unwrap()), true)
                        .unwrap()
                        .float();
                    for v in &mut sig.data {
                        *v /= 255.;
                    }
                    sig
                })
                .collect();
            c.feed_rows(call[0].as_f64().unwrap(), rows).unwrap();
        }
        assert_eq!(c.events.iter().map(|e| e.t).collect::<Vec<_>>(), expected);
    }
}
