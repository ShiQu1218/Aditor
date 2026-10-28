#![allow(dead_code)]
use aditor::{
    cv::{self, Image},
    scene::SceneFrame,
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};
pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")
}
pub fn cases() -> &'static Value {
    static DOC: OnceLock<Value> = OnceLock::new();
    DOC.get_or_init(|| serde_json::from_str(include_str!("../parity/phase_c/cases.json")).unwrap())
}
pub fn image(key: &str) -> Image<u8> {
    cv::read_png(
        &root().join(cases()["frames"][key].as_str().unwrap()),
        false,
    )
    .unwrap()
}
pub fn scene(v: &Value) -> SceneFrame {
    let kind = match v["kind"].as_str().unwrap() {
        "pre_match" => "pre_match",
        "lobby" => "lobby",
        "in_match_hud" => "in_match_hud",
        _ => "other",
    };
    SceneFrame {
        kind,
        match_context: v["match_context"].as_bool().unwrap(),
        blank: v["blank"].as_bool().unwrap(),
        scores: serde_json::from_value(v["scores"].clone()).unwrap(),
    }
}
pub fn screen(file: &str) -> Image<u8> {
    let dir = root().join("fixtures/matches");
    let d: Value =
        serde_json::from_slice(&std::fs::read(dir.join("screens.json")).unwrap()).unwrap();
    let a = cv::read_png(&dir.join(file), true).unwrap();
    let mut frame = Image::new(640, 360, 1, vec![0; 640 * 360]).unwrap();
    let mut row = 0;
    for r in d["rois"].as_array().unwrap() {
        let [x, y, w, h] = [1, 2, 3, 4].map(|i| r[i].as_u64().unwrap() as usize);
        for yy in 0..h {
            frame.data[(y + yy) * 640 + x..(y + yy) * 640 + x + w]
                .copy_from_slice(&a.data[(row + yy) * a.width..(row + yy) * a.width + w]);
        }
        row += h;
    }
    frame
}
pub fn close(a: &Value, b: &Value) {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => assert!(
            (a.as_f64().unwrap() - b.as_f64().unwrap()).abs() < 1e-4,
            "{a} != {b}"
        ),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len());
            for (a, b) in a.iter().zip(b) {
                close(a, b);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{a:?} != {b:?}");
            for (k, v) in a {
                close(v, &b[k]);
            }
        }
        _ => assert_eq!(a, b),
    }
}
pub fn number(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| match v.as_str().unwrap() {
        "nan" => f64::NAN,
        "inf" => f64::INFINITY,
        _ => f64::NEG_INFINITY,
    })
}

pub fn cases_reference() -> Value {
    serde_json::from_str(include_str!("../parity/phase_c/reference.json")).unwrap()
}
