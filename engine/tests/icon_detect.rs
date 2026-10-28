mod common;
use aditor::{
    cv::Image,
    icon_detect::{enemy_color_mask, is_knock, IconDetector, IconFrame, IconParams},
};
#[test]
fn enemy_colors_and_figure_ties_match_python() {
    let pixels = Image::new(
        4,
        1,
        3,
        vec![40, 40, 220, 59, 171, 180, 163, 152, 220, 200, 200, 200],
    )
    .unwrap();
    assert_eq!(enemy_color_mask(&pixels).data, vec![1, 1, 1, 0]);
    let p = common::profile();
    let icons = IconDetector::new(
        &p.dir,
        &[1.],
        Some(IconParams {
            fig_lead: 0.,
            ..Default::default()
        }),
        false,
    )
    .unwrap();
    let mut f = IconFrame {
        chev: 0.9,
        plus: 0.9,
        person: 0.8,
        group: 0.8,
        ..Default::default()
    };
    assert_eq!(icons.classify(&f).as_deref(), Some("score_other"));
    f.person = 0.81;
    assert_eq!(icons.classify(&f).as_deref(), Some("assist_knock"));
    f.name_color = 100;
    assert_eq!(icons.classify(&f).as_deref(), Some("knock"));
}
#[test]
fn damage_and_enemy_color_use_background_subtraction() {
    let p = IconParams::default();
    let mut f = IconFrame {
        name_color: 100,
        name_color_bg: 100,
        line2_ink: 0.1,
        line2_ink_bg: 0.1,
        ..Default::default()
    };
    assert!(!is_knock(&f, &p));
    f.name_color_bg = 0;
    assert!(is_knock(&f, &p));
    f.name_color = 0;
    f.line2_ink_bg = 0.;
    assert!(is_knock(&f, &p));
}
#[test]
fn scale_probe_features_equal_full_features() {
    let p = common::profile();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/en/pos/knock_a002500.png");
    let im = aditor::cv::read_png(&path, false).unwrap();
    let banner = im.crop(0, 0, 800, 180).unwrap();
    for scales in [&[1.][..], &aditor::icon_detect::DEFAULT_SCALES] {
        let icons = IconDetector::new(&p.dir, scales, None, false).unwrap();
        let expected = icons.features(&banner).unwrap();
        let actual = icons.score_features(&banner).unwrap();
        assert_eq!(
            (
                actual.chev,
                actual.chev_x,
                actual.chev_y,
                actual.chev_scale,
                actual.plus,
                actual.plus_x,
                actual.row_h
            ),
            (
                expected.chev,
                expected.chev_x,
                expected.chev_y,
                expected.chev_scale,
                expected.plus,
                expected.plus_x,
                expected.row_h
            )
        );
    }
}
