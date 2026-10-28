mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::valorant_rounds::*;
use serde_json::json;
#[test]
fn python_scoreboard_traces_and_highlights() {
    for c in parity::cases()["round_traces"].as_array().unwrap() {
        let origin = serde_json::from_value(c["origin"].clone()).unwrap();
        let mut tr = RoundTracker::new(origin, c["fps"].as_f64().unwrap());
        let mut images = std::collections::HashMap::new();
        for call in c["calls"].as_array().unwrap() {
            let id = call["frame"].as_str().unwrap();
            let img = images.entry(id).or_insert_with(|| parity::image(id));
            let got = tr.feed(call["t"].as_f64().unwrap(), img).unwrap();
            parity::close(&json!(got), &call["new"]);
        }
        parity::close(&json!(tr.rounds), &c["rounds"]);
    }
    for c in parity::cases()["highlights"].as_array().unwrap() {
        let got = round_highlights(
            &serde_json::from_value::<Vec<_>>(c["events"].clone()).unwrap(),
            &serde_json::from_value::<Vec<_>>(c["rounds"].clone()).unwrap(),
        );
        parity::close(&json!(got), &c["expected"]);
    }
}
