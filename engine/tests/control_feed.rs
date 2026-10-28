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
        let mut live = LiveKills::new(&p, KillLimits::default()).unwrap();
        for call in c["calls"].as_array().unwrap() {
            let b = parity::image(call["banner"].as_str().unwrap());
            let s = parity::image(call["spec"].as_str().unwrap());
            let f = call["killfeed"].as_str().map(parity::image);
            live.feed(call["t"].as_f64().unwrap(), &b, &s, f.as_ref(), None)
                .unwrap();
            let (e, s) = live.snapshot();
            parity::close(&json!({"events":e,"spectating":s}), &call["snapshot"]);
        }
        let (e, s) = live.finish().unwrap();
        parity::close(&json!({"events":e,"spectating":s}), &c["final"]);
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
