mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{
    cv::{self, Image, Interpolation},
    game_detect::*,
};
#[test]
fn recognizes_apex_and_neither_and_rejects_ties() {
    let mut positive = vec![];
    let mut other = vec![];
    for c in parity::cases()["scene"].as_array().unwrap() {
        let f = parity::screen(c["file"].as_str().unwrap());
        let f = cv::resize(&f, 1920, 1080, Interpolation::Linear).unwrap();
        let bgr = Image::new(1920, 1080, 3, f.data.iter().flat_map(|v| [*v; 3]).collect()).unwrap();
        if c["full"]["kind"] == "other" {
            other.push(bgr);
        } else {
            positive.push(bgr);
        }
    }
    let n = positive.len();
    let hits = count_hits(positive, None).unwrap();
    assert!(hits["apex"] >= n - 1);
    assert_eq!(hits["valorant"], 0);
    assert_eq!(pick_game(&hits).as_deref(), Some("apex"));
    assert!(pick_game(&count_hits(other, None).unwrap()).is_none());
    assert!(pick_game(&std::collections::BTreeMap::from([
        ("apex".into(), 4),
        ("valorant".into(), 4)
    ]))
    .is_none());
    let mut frame = Image::new(1920, 1080, 3, [40, 50, 60].repeat(1920 * 1080)).unwrap();
    for (x, y, w, h, color) in [
        (796, 36, 56, 26, [150, 140, 140]),
        (1140, 34, 56, 30, [70, 80, 240]),
    ] {
        for yy in y..y + h {
            for xx in x..x + w {
                frame.data[(yy * 1920 + xx) * 3..(yy * 1920 + xx + 1) * 3].copy_from_slice(&color);
            }
        }
    }
    let hits = count_hits(vec![frame; 4], None).unwrap();
    assert_eq!(hits["apex"], 0);
    assert_eq!(hits["valorant"], 4);
    assert_eq!(pick_game(&hits).as_deref(), Some("valorant"));
}
