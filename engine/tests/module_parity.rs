mod common;
use aditor::{
    aspect, games,
    layout::{self, Anchor},
    models::VideoInfo,
};
use common::{make_video, TempDir, VideoOptions};
use serde_json::Value;
fn oracle() -> Value {
    serde_json::from_slice(
        &std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/modules.json"),
        )
        .expect("Generate tools/dump_parity.py first"),
    )
    .unwrap()
}
#[test]
fn layout_profile_games_and_aspect_match_python() {
    let doc = oracle();
    for c in doc["layout"].as_array().unwrap() {
        let lay = layout::parse_aspect(c["name"].as_str().unwrap()).unwrap();
        assert_eq!(lay.squash, c["squash"].as_f64().unwrap());
        let rect = serde_json::from_value(c["rect"].clone()).unwrap();
        let anchor = match c["anchor"].as_str().unwrap() {
            "top" => Anchor::Top,
            "bottom" => Anchor::Bottom,
            _ => Anchor::Center,
        };
        assert_eq!(
            lay.source_rect(rect, anchor),
            serde_json::from_value::<[f64; 4]>(c["source"].clone()).unwrap()
        );
        assert_eq!(
            serde_json::to_value(layout::capture_rect(rect, anchor)).unwrap(),
            c["capture"]
        );
    }
    let p = common::profile();
    let expected = &doc["profile"];
    assert_eq!(p.templates_version, expected["templates_version"]);
    assert_eq!(p.white, expected["white"]);
    assert_eq!(p.red, expected["red"]);
    assert_eq!(
        serde_json::to_value(p.banner_roi).unwrap(),
        expected["banner_roi"]
    );
    assert_eq!(
        serde_json::to_value(p.spec_roi).unwrap(),
        expected["spec_roi"]
    );
    assert_eq!(
        serde_json::to_value(p.capture_banner()).unwrap(),
        expected["capture_banner"]
    );
    assert_eq!(
        serde_json::to_value(p.capture_spec()).unwrap(),
        expected["capture_spec"]
    );
    assert_eq!(
        serde_json::to_value(p.capture_killfeed()).unwrap(),
        expected["capture_killfeed"]
    );
    assert_eq!(p.name_sig_threshold, expected["name_sig_threshold"]);
    assert_eq!(p.dedupe_window, expected["dedupe_window"]);
    for (actual, expected) in p
        .spectating
        .iter()
        .zip(expected["spectating"].as_array().unwrap())
    {
        assert_eq!(actual.file, expected["file"]);
        assert_eq!(actual.threshold, expected["threshold"]);
        assert_eq!(actual.white, expected["white"]);
    }
    for c in doc["games"].as_array().unwrap() {
        let info = VideoInfo {
            game: c["tag"].as_str().map(str::to_owned),
            ..Default::default()
        };
        assert_eq!(
            games::resolve_game(c["explicit"].as_str(), Some(&info)).unwrap(),
            c["expected"]
        );
    }
    for c in doc["aspect"].as_array().unwrap() {
        let stats: aspect::AspectStats = serde_json::from_value(c["stats"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(aspect::pick_aspect(&stats)).unwrap(),
            c["expected"]
        );
    }
}
#[test]
fn synthetic_probe_matches_python() {
    let d = TempDir::new();
    let v = make_video(
        &d.0,
        "空白 名稱.mp4",
        1.,
        VideoOptions {
            game_aspect: Some("1920x1440"),
            ..Default::default()
        },
    );
    let mut info = serde_json::to_value(aditor::probe::probe(&v).unwrap()).unwrap();
    for key in ["path", "size", "mtime"] {
        info.as_object_mut().unwrap().remove(key);
    }
    let expected = oracle();
    assert_eq!(info, expected["probe"]["info"]);
    assert_eq!(
        serde_json::to_value(aditor::probe::keyframes(v).unwrap()).unwrap(),
        expected["probe"]["keyframes"]
    );
}
