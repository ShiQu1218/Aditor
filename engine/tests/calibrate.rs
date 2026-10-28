mod common;
use aditor::{
    calibrate::*,
    cv::Image,
    detect::{consensus, Keywords},
};
use serde_json::json;
#[test]
fn scale_median_and_tie_prefer_identity() {
    assert_eq!(pick_scale(&[]), 1.);
    assert_eq!(pick_scale(&[1., 1., 0.95]), 1.);
    assert_eq!(pick_scale(&[1.05, 1.1, 1.1, 1.05, 1.1]), 1.1);
    assert_eq!(pick_scale(&[0.95, 1.]), 1.);
}
#[test]
fn keyword_roundtrip_rejects_corrupt_templates() {
    let kw = Keywords {
        assist: Some(
            Image::new(4, 4, 1, (0..16).map(|i| f32::from(i % 3 == 0)).collect()).unwrap(),
        ),
        ..Default::default()
    };
    assert_eq!(Keywords::from_dict(Some(&kw.to_dict())).unwrap(), kw);
    assert!(Keywords::from_dict(None).unwrap().empty());
    for bad in [
        json!({"assist":{"shape":[27,64],"q8":"AAAA"}}),
        json!({"assist":{"shape":[27],"q8":"AAAA"}}),
        json!({"knock":{"shape":[2,2],"q8":"!!!not-base64!!!"}}),
        json!({"knock":"x"}),
        json!("x"),
    ] {
        assert!(Keywords::from_dict(Some(&bad)).is_err());
    }
}
#[test]
fn consensus_needs_three_banners_and_ink() {
    let ones = Image::new(4, 4, 1, vec![1.; 16]).unwrap();
    assert!(consensus(&[ones.clone(), ones.clone()], 2).is_none());
    assert!(consensus(&[ones.clone(), ones.clone(), ones], 3).is_some());
    let zeros = Image::new(4, 4, 1, vec![0.; 16]).unwrap();
    assert!(consensus(&[zeros.clone(), zeros.clone(), zeros], 3).is_none());
}
#[test]
fn extended_learning_fills_only_missing_templates() {
    let tpl = Image::new(4, 4, 1, vec![1.; 16]).unwrap();
    let base = Keywords {
        knock: Some(tpl.clone()),
        assist_by_knock: true,
        ..Default::default()
    };
    let wider = Keywords {
        assist: Some(tpl),
        assist_by_knock: false,
        ..Default::default()
    };
    assert!(keywords_complete(Some(&base)));
    let extended = extend_keywords(&base, &wider);
    assert!(extended.assist.is_some());
    assert!(extended.assist_by_knock);
    assert_eq!(extended.knock, base.knock);
    assert!(same_keywords(None, Some(&Keywords::default())));
}
#[test]
fn anchor_groups_merge_across_segment_boundaries() {
    let tpl = Image::new(2, 2, 1, vec![1.; 4]).unwrap();
    let mut a = Anchors::default();
    for t in [0., 0.25, 0.5, 4., 8., 12., 16.] {
        a.add(t, tpl.clone());
    }
    assert!(a.done());
    assert_eq!(a.groups.len(), 4);
    assert_eq!(a.groups[0].strips.len(), 2);
    assert!(!a.accepts(16.));
    let mut b = Anchors::default();
    b.add(12.25, tpl);
    let merged = merge_groups([a.groups, b.groups]);
    assert_eq!(merged.len(), 4);
    assert_eq!(merged[3].last, 12.25);
}

#[test]
fn calibration_and_keyword_scan_honor_cancellation_and_decode_failures() {
    let p = common::profile();
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/media/knocks.mp4");
    let path = path.to_str().unwrap();
    let info = aditor::probe::probe(path).unwrap();
    assert_eq!(calibrate(path, &info, &p, 20., None, false).unwrap(), 1.);
    let cancel = std::sync::atomic::AtomicBool::new(true);
    assert!(calibrate(path, &info, &p, 20., Some(&cancel), false)
        .unwrap_err()
        .is::<aditor::errors::Cancelled>());
    assert!(
        learn_keywords(path, &info, &p, 1., 4, 900., Some(&cancel), false)
            .unwrap_err()
            .is::<aditor::errors::Cancelled>()
    );
    let missing = aditor::models::VideoInfo {
        duration: 600.,
        codec: "h264".into(),
        ..Default::default()
    };
    assert!(
        learn_keywords("missing.mp4", &missing, &p, 1., 4, 900., None, false)
            .unwrap_err()
            .is::<aditor::decode::DecodeError>()
    );
}

#[test]
fn calibration_keeps_wide_spectator_profiles_decodable() {
    let mut p = common::profile();
    p.banner_roi[2] = 400;
    assert!(p.capture_spec()[2] > p.capture_banner()[2]);
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/media/knocks.mp4");
    let path = path.to_str().unwrap();
    let info = aditor::probe::probe(path).unwrap();
    assert_eq!(calibrate(path, &info, &p, 1., None, false).unwrap(), 1.);
}
