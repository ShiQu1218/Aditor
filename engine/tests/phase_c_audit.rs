mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{
    detect::{Detector, Keywords},
    events::EventTracker,
    models::{FrameResult, NameSig},
};
use serde_json::{json, Value};
fn frame(v: &Value) -> FrameResult {
    FrameResult {
        kind: v["kind"].as_str().map(str::to_owned),
        score: v["score"].as_f64().unwrap(),
        x: v["x"].as_i64().unwrap() as i32,
        damage_line: v["damage_line"].as_bool().unwrap(),
        name_sig: v["name_sig"]
            .as_str()
            .map(|s| NameSig::from_b64(s).unwrap()),
        spectating: v["spectating"].as_bool().unwrap(),
        hint: v["hint"].as_str().map(str::to_owned),
    }
}
#[test]
fn all_mixtape_mutations_and_keyword_language_regressions_match_python() {
    let doc: Value = serde_json::from_str(include_str!("parity/phase_c/audit.json")).unwrap();
    let p = common::profile();
    assert_eq!(doc["executed"].as_array().unwrap().len(), 38);
    for c in doc["detections"].as_array().unwrap() {
        let image = |key: &str| {
            let recipe = &doc["frames"][c[key].as_str().unwrap()];
            let file = recipe
                .as_str()
                .unwrap_or_else(|| recipe["file"].as_str().unwrap());
            let image = aditor::cv::read_png(&parity::root().join(file), false).unwrap();
            if let Some(rect) = recipe["rect"].as_array() {
                image
                    .crop(
                        rect[0].as_u64().unwrap() as usize,
                        rect[1].as_u64().unwrap() as usize,
                        rect[2].as_u64().unwrap() as usize,
                        rect[3].as_u64().unwrap() as usize,
                    )
                    .unwrap()
            } else {
                image
            }
        };
        let kw = Keywords::from_dict(Some(&c["keywords"])).unwrap();
        let detector = Detector::new(&p, c["scale"].as_f64().unwrap(), None, Some(kw)).unwrap();
        let out = detector.detect(&image("banner"), &image("spec")).unwrap();
        parity::close(
            &json!({"kind":out.kind,"score":out.score,"x":out.x,"damage_line":out.damage_line,"name_sig":out.name_sig.map(|s|s.to_b64()),"spectating":out.spectating,"hint":out.hint}),
            &c["expected"],
        );
    }
    for trace in doc["traces"].as_array().unwrap() {
        let mut tracker = EventTracker::new(&p, None);
        for call in trace["frames"].as_array().unwrap() {
            tracker.feed(call[0].as_f64().unwrap(), frame(&call[1]));
        }
        let (events, spec) = tracker.finish();
        parity::close(&json!([events, spec]), &trace["expected"]);
    }
}
