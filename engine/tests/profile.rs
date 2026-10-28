mod common;
use aditor::{
    layout::{self, Anchor, BANNER_ANCHOR, SPEC_ANCHOR},
    profile::*,
};
use common::TempDir;
use serde_json::{json, Value};
use std::path::Path;
fn copied_profile(mutate: impl FnOnce(&mut Value)) -> TempDir {
    let tmp = TempDir::new();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/icons");
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file() {
            std::fs::copy(entry.path(), tmp.0.join(entry.file_name())).unwrap();
        }
    }
    let path = tmp.0.join("profile.json");
    let mut doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    mutate(&mut doc);
    std::fs::write(path, serde_json::to_vec(&doc).unwrap()).unwrap();
    tmp
}
#[test]
fn shipped_profile_and_templates() {
    let p = common::profile();
    assert!(p.templates_version.starts_with("icons@"));
    assert_eq!(p.banner_roi, [560, 700, 800, 180]);
    assert_eq!(p.dedupe_window, 90.);
    let mut total = 0;
    for name in ICON_NAMES {
        total += std::fs::metadata(p.dir.join(format!("{name}.png")))
            .unwrap()
            .len();
    }
    for s in &p.spectating {
        total += std::fs::metadata(p.dir.join(&s.file)).unwrap().len();
    }
    assert!(total < 100_000);
    for lang in ["zh-TW", "en", "ja"] {
        assert!(p
            .spectating
            .iter()
            .any(|s| s.file == format!("spec_{lang}_show_flag.png")));
    }
}
#[test]
fn missing_templates() {
    for file in ICON_NAMES
        .map(|n| format!("{n}.png"))
        .into_iter()
        .chain(["spec_en_show_flag.png".into()])
    {
        let d = copied_profile(|_| {});
        std::fs::remove_file(d.0.join(&file)).unwrap();
        assert_eq!(
            load_profile(&d.0).unwrap_err().to_string(),
            format!("Template file is missing: {file}")
        );
    }
}
#[test]
fn missing_profile_invalid_json_and_non_object() {
    let d = TempDir::new();
    assert!(load_profile(&d.0).is_err());
    for text in ["{bad", "[]", "null"] {
        std::fs::write(d.0.join("profile.json"), text).unwrap();
        assert!(load_profile(&d.0).is_err());
    }
}
#[test]
fn all_required_fields() {
    for k in [
        "templates_version",
        "banner_roi",
        "spec_roi",
        "white",
        "red",
        "spectating",
        "name_sig_threshold",
        "dedupe_window",
    ] {
        let d = copied_profile(|v| {
            v.as_object_mut().unwrap().remove(k);
        });
        assert_eq!(
            load_profile(&d.0).unwrap_err().to_string(),
            format!("Missing field in profile.json: {k}")
        );
    }
}
#[test]
fn rejects_invalid_fields() {
    for (pointer, value, field) in [
        ("/banner_roi", json!([1, 2, 3]), "banner_roi"),
        ("/banner_roi", json!([0, 0, 0, 180]), "banner_roi"),
        ("/white/v_min", Value::Null, "v_min"),
        ("/red/r_min", Value::Null, "r_min"),
        ("/name_sig_threshold", json!(0), "name_sig_threshold"),
        ("/dedupe_window", json!(-1), "dedupe_window"),
        ("/templates_version", json!(""), "templates_version"),
        ("/spectating", json!({}), "spectating"),
        ("/spectating/0/threshold", json!(1.5), "threshold"),
        ("/spectating/0/file", Value::Null, "file"),
        ("/spectating/0/file", json!("../profile.json"), "file"),
        ("/red/yellow/rg_max", Value::Null, "red.yellow.rg_max"),
        ("/red/pink", json!("x"), "red.pink"),
        ("/red/pink/bg_min", json!("a"), "red.pink.bg_min"),
        ("/white/v_min", json!(true), "v_min"),
        ("/killfeed_roi", json!([0, 0, 1921, 5]), "killfeed_roi"),
    ] {
        let d = copied_profile(|v| {
            *v.pointer_mut(pointer).unwrap() = value;
        });
        let error = load_profile(&d.0).unwrap_err().to_string();
        assert!(error.contains(field), "{pointer}: {error}");
    }
}
#[test]
fn empty_spectating_and_layout_override() {
    let d = copied_profile(|v| v["spectating"] = json!([]));
    assert!(load_profile(&d.0).unwrap().spectating.is_empty());
    let p = common::profile();
    let q = p.with_layout(layout::parse_aspect("4:3").unwrap());
    assert_eq!(q.layout.squash, 0.75);
    assert!(p.layout.identity());
    assert_eq!(q.banner_roi, p.banner_roi);
}
#[test]
fn shipped_capture_rois() {
    let p = common::profile();
    let doc: Value =
        serde_json::from_slice(&std::fs::read(p.dir.join("profile.json")).unwrap()).unwrap();
    for (name, rect, anchor) in [
        ("banner", p.banner_roi, BANNER_ANCHOR),
        ("spec", p.spec_roi, SPEC_ANCHOR),
        ("killfeed", p.killfeed_roi.unwrap(), Anchor::Top),
    ] {
        assert_eq!(
            serde_json::to_value(layout::capture_rect(rect, anchor)).unwrap(),
            doc["capture_rois"][name]
        );
    }
}

#[test]
fn oversized_rois_are_profile_errors_before_decoder_arithmetic() {
    for key in ["banner_roi", "spec_roi"] {
        for roi in [
            json!([0, 0, i32::MAX, i32::MAX]),
            json!([i32::MAX, 0, 1, 1]),
            json!([0, 1080, 1, 1]),
        ] {
            let tmp = copied_profile(|doc| doc[key] = roi);
            let error = load_profile(&tmp.0).unwrap_err();
            assert!(error.is::<ProfileError>());
            assert_eq!(
                error.to_string(),
                format!("profile.json {key} must fit within 1920×1080")
            );
        }
    }
}
