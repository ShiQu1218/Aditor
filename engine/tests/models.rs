use aditor::models::*;
use serde_json::json;
#[test]
fn namesig_roundtrip() {
    for width in [0, 1, 7, 40, 128] {
        let bits = (0..16 * width)
            .map(|i| u8::from((i * 37 + 11) % 17 > 8))
            .collect();
        let sig = NameSig { width, bits };
        assert_eq!(NameSig::from_b64(&sig.to_b64()).unwrap(), sig);
    }
    assert_eq!(
        NameSig {
            width: 1,
            bits: vec![1; 16]
        }
        .to_b64(),
        "1://8="
    );
}
#[test]
fn namesig_invalid_data() {
    assert!(NameSig::from_b64("bad").is_err());
    assert!(NameSig::from_b64("40:AA==").is_err());
    assert_eq!(
        NameSig::from_b64("1://8").unwrap_err().to_string(),
        "Incorrect padding"
    );
}
#[test]
fn event_dict_roundtrip() {
    let event:Event=serde_json::from_value(json!({"id":"e1","t":812.25,"type":"knock","score":0.91,"damage_line":true,"name_sig":null,"future_field":true})).unwrap();
    let value = serde_json::to_value(&event).unwrap();
    assert!(value["counted_override"].is_null());
    assert_eq!(value["source"], "auto");
    assert_eq!(serde_json::from_value::<Event>(value).unwrap(), event);
}
#[test]
fn defaults_and_other_models() {
    assert_eq!(
        serde_json::from_value::<AutoClipParams>(json!({"n":4,"unknown":1}))
            .unwrap()
            .n,
        4
    );
    assert_eq!(
        serde_json::from_value::<AutoClipParams>(json!({})).unwrap(),
        AutoClipParams::default()
    );
    let clip: Clip =
        serde_json::from_value(json!({"id":"c","start":1.,"end":2.,"origin":"manual"})).unwrap();
    assert!(clip.event_ids.is_empty());
    let info:VideoInfo=serde_json::from_value(json!({"path":"x","duration":1.,"width":1,"height":1,"codec":"h264","start_time":0.,"size":1,"mtime":0.})).unwrap();
    assert_eq!(info.fps, 0.);
    assert!(info.game.is_none());
}
