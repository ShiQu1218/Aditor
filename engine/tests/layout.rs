use aditor::{cv::Image, layout::*};
#[test]
fn supported_and_resolution_aspects() {
    for (text, squash) in [
        ("16:9", 1.),
        ("16:10", 0.9),
        ("4:3", 0.75),
        ("5:4", 0.703125),
        ("1920x1440", 0.75),
        ("2560x1440", 1.),
        ("1680x1050", 0.9),
        ("1366×768", 1.),
        (" 4 : 3 ", 0.75),
    ] {
        assert!((parse_aspect(text).unwrap().squash - squash).abs() < 1e-12);
    }
}
#[test]
fn invalid_and_unsupported_aspects() {
    for text in [
        "",
        "4:",
        "0:3",
        "21:9",
        "3840x1600",
        "1:1",
        "x",
        "4:3:1",
        "-4:3",
    ] {
        assert!(parse_aspect(text).is_err(), "{text}");
    }
    for n in [400, 5000] {
        let text = format!("{}:1", "9".repeat(n));
        assert_eq!(recorded_layout(Some(&text)), Layout::default());
        assert!(tagged_layout(Some(&text)).is_none());
    }
    for text in [None, Some(""), Some("invalid"), Some("21:9")] {
        assert!(tagged_layout(text).is_none());
    }
}
#[test]
fn anchors_and_capture_union() {
    let lay = Layout { squash: 0.75 };
    assert_eq!(
        lay.source_rect([21, 21, 309, 375], Anchor::Top),
        [21., 15.75, 309., 281.25]
    );
    assert_eq!(
        lay.source_rect([560, 700, 800, 180], Anchor::Center),
        [560., 660., 800., 135.]
    );
    assert_eq!(
        lay.source_rect([99, 873, 366, 183], Anchor::Bottom),
        [99., 924.75, 366., 137.25]
    );
    for (rect, anchor) in [
        ([560, 700, 800, 180], BANNER_ANCHOR),
        ([60, 950, 480, 118], SPEC_ANCHOR),
    ] {
        let [x, y, w, h] = capture_rect(rect, anchor);
        assert!(y >= 0 && y + h <= 1080);
        assert_eq!((x, w), (rect[0], rect[2]));
        for (_, r) in SUPPORTED_ASPECTS {
            let s = Layout::from_ratio(r).source_rect(rect, anchor);
            assert!(y as f64 <= s[1] && s[1] + s[3] <= (y + h) as f64);
        }
    }
}
#[test]
fn extract_crop_and_restore() {
    let rect = [560, 700, 800, 180];
    let cap = capture_rect(rect, BANNER_ANCHOR);
    let mut img = Image::new(
        cap[2] as usize,
        cap[3] as usize,
        3,
        vec![0; cap[2] as usize * cap[3] as usize * 3],
    )
    .unwrap();
    let lay = Layout { squash: 0.75 };
    let s = lay.source_rect(rect, BANNER_ANCHOR);
    let top = s[1].round_ties_even() as usize - cap[1] as usize;
    let height = s[3].round_ties_even() as usize;
    img.data[top * img.width * 3..(top + height) * img.width * 3].fill(200);
    let out = lay.extract(&img, cap, rect, BANNER_ANCHOR).unwrap();
    assert_eq!((out.width, out.height, out.channels), (800, 180, 3));
    assert!(out.data[2 * 800 * 3..178 * 800 * 3]
        .iter()
        .all(|&v| v == 200));
    assert_eq!(
        Layout::default()
            .extract(&img, cap, rect, BANNER_ANCHOR)
            .unwrap(),
        img.crop(0, (700 - cap[1]) as usize, 800, 180).unwrap()
    );
    assert!(lay
        .extract(
            &Image::new(1, 1, 1, vec![0]).unwrap(),
            cap,
            rect,
            BANNER_ANCHOR
        )
        .is_err());
}
#[test]
fn reference_thumbnail() {
    let mut img = Image::new(640, 360, 1, vec![0; 640 * 360]).unwrap();
    assert_eq!(Layout::default().reference_thumb(&img).unwrap(), img);
    let lay = Layout { squash: 0.75 };
    let rect = [99, 873, 366, 183];
    let s = lay.source_rect(rect, Anchor::Bottom);
    for y in (s[1] / 3.).round_ties_even() as usize..((s[1] + s[3]) / 3.).round_ties_even() as usize
    {
        for x in 33..155 {
            img.data[y * 640 + x] = 255;
        }
    }
    let out = lay.reference_thumb(&img).unwrap();
    for y in 293..350 {
        for x in 35..153 {
            assert_eq!(out.data[y * 640 + x], 255);
        }
    }
}

#[test]
fn corrupt_cached_squash_returns_layout_error_without_integer_overflow() {
    let image = aditor::cv::Image::new(800, 260, 3, vec![0; 800 * 260 * 3]).unwrap();
    for squash in [f64::MAX, -f64::MAX, f64::NAN, f64::INFINITY, 0.] {
        assert!(Layout { squash }
            .extract(
                &image,
                [560, 600, 800, 260],
                [560, 700, 800, 180],
                Anchor::Center
            )
            .is_err());
    }
}
