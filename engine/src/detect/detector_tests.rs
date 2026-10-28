use super::*;
#[test]
fn player_name_template_cannot_be_mistaken_for_spectating() {
    let p = crate::profile::load_profile(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/icons"),
    )
    .unwrap();
    let detector = Detector::new(&p, 1., None, None).unwrap();
    let template = cv::read_png(&p.dir.join("spec_en_next_mate.png"), true).unwrap();
    let mut spec = Image::new(480, 118, 3, vec![0; 480 * 118 * 3]).unwrap();
    for (top, expected) in [(15, false), (80, true)] {
        spec.data.fill(0);
        for y in 0..template.height {
            for x in 0..template.width {
                let start = ((y + top) * 480 + x + 112) * 3;
                spec.data[start..start + 3].fill(template.data[y * template.width + x]);
            }
        }
        assert_eq!(detector.spectating(&spec).unwrap(), expected);
    }
}
