mod common;
use aditor::{
    derive::*,
    models::{Event, NameSig},
};
use serde_json::{json, Value};

fn signature(width: usize) -> String {
    NameSig {
        width,
        bits: (0..16 * width).map(|i| u8::from(i % 3 == 0)).collect(),
    }
    .to_b64()
}
fn event(t: f64, sig: Value) -> Event {
    serde_json::from_value(json!({"id":format!("e{t}"),"t":t,"type":"knock","score":0.9,"damage_line":false,"name_sig":sig})).unwrap()
}
#[test]
fn signature_helpers_reject_missing_invalid_and_different_widths() {
    let sig = signature(60);
    assert!(sig_similar(Some(&sig), Some(&sig), 0.32));
    for other in [
        None,
        Some("bad"),
        Some("60:AA=="),
        Some(signature(48).as_str()),
    ] {
        assert!(!sig_similar(Some(&sig), other, 0.32));
        assert!(!sig_similar(other, Some(&sig), 0.32));
    }
    assert!(!sig_similar(None, None, 0.32));
    let mut e = event(0., Value::Null);
    e.counted = true;
    e.counted_override = Some(true);
    e.deleted = true;
    assert!(!is_counted(&e));
    e.counted_override = None;
    assert!(!is_counted(&e));
}
#[test]
fn dedupe_boundary_invalid_signatures_and_input_immutability() {
    let p = common::profile();
    let sig = signature(60);
    let events: Vec<_> = [0., 45., 90., 90.25, 180.25, 180.5]
        .into_iter()
        .map(|t| event(t, json!(sig)))
        .rev()
        .collect();
    let before = events.clone();
    let reasons: Vec<_> = derive(&events, &[], &p)
        .into_iter()
        .map(|e| e.counted_reason)
        .collect();
    assert_eq!(
        reasons,
        [
            "first",
            "duplicate",
            "duplicate",
            "first",
            "duplicate",
            "first"
        ]
    );
    assert_eq!(json!(events), json!(before));
    let events: Vec<_> = [
        Value::Null,
        json!(""),
        json!("bad"),
        json!("60:AA=="),
        json!([]),
        json!({}),
        json!(sig),
        json!(sig),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, s)| event(i as f64, s))
    .collect();
    assert_eq!(
        derive(&events, &[], &p)
            .iter()
            .map(|e| e.counted)
            .collect::<Vec<_>>(),
        [true, true, true, true, true, true, true, false]
    );
    let mut changed = NameSig::from_b64(&sig).unwrap();
    for x in 10..15 {
        changed.bits[4 * 60 + x] ^= 1;
    }
    let changed = changed.to_b64();
    let events = [
        event(0., json!(sig)),
        event(1., json!(changed)),
        event(91., json!(changed)),
    ];
    assert_eq!(
        derive(&events, &[], &p)
            .iter()
            .map(|e| e.counted)
            .collect::<Vec<_>>(),
        [true, false, true]
    );
}
