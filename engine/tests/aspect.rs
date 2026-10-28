mod common;
use aditor::{
    aspect::*,
    cv::{self, Image, Interpolation},
    layout::{self, Anchor, Layout},
    models::VideoInfo,
};
use serde_json::Value;
use std::{path::Path, sync::atomic::AtomicBool};
fn positive_screens() -> Vec<Image<u8>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/matches");
    let doc: Value =
        serde_json::from_slice(&std::fs::read(dir.join("screens.json")).unwrap()).unwrap();
    doc["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["scene"] == "in_match_hud" || c["scene"] == "lobby")
        .map(|c| {
            let atlas = cv::read_png(&dir.join(c["file"].as_str().unwrap()), true).unwrap();
            let mut frame = Image::new(640, 360, 1, vec![0; 640 * 360]).unwrap();
            let mut row = 0;
            for roi in doc["rois"].as_array().unwrap() {
                let [x, y, w, h] = [1, 2, 3, 4].map(|i| roi[i].as_u64().unwrap() as usize);
                for r in 0..h {
                    frame.data[(y + r) * 640 + x..(y + r) * 640 + x + w].copy_from_slice(
                        &atlas.data[(row + r) * atlas.width..(row + r) * atlas.width + w],
                    );
                }
                row += h;
            }
            frame
        })
        .collect()
}
fn stretch(frame: &Image<u8>, name: &str) -> Image<u8> {
    if name == "16:9" {
        return frame.clone();
    }
    let ratio = layout::SUPPORTED_ASPECTS
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap()
        .1;
    let height = (640. / ratio).round_ties_even() as usize;
    let mut canvas = Image::new(640, height, 1, vec![0; 640 * height]).unwrap();
    let spare = height - 360;
    for (rect, anchor) in layout::SCENE_ROIS {
        let [x, y, w, h] = rect.map(|v| v as usize / 3);
        let shift = match anchor {
            Anchor::Top => 0,
            Anchor::Center => spare / 2,
            Anchor::Bottom => spare,
        };
        for r in 0..h {
            canvas.data[(y + shift + r) * 640 + x..(y + shift + r) * 640 + x + w]
                .copy_from_slice(&frame.data[(y + r) * 640 + x..(y + r) * 640 + x + w]);
        }
    }
    cv::resize(&canvas, 640, 360, Interpolation::Area).unwrap()
}
#[test]
fn picks_minimum_count_then_reference_then_score() {
    let stats = |v: Vec<(&str, (usize, f64))>| {
        v.into_iter()
            .map(|(n, s)| (n.into(), s))
            .collect::<AspectStats>()
    };
    assert_eq!(
        pick_aspect(&stats(vec![("16:9", (0, 0.)), ("4:3", (2, 9.))])),
        None
    );
    assert_eq!(
        pick_aspect(&stats(vec![("16:9", (0, 0.)), ("4:3", (3, 1.))])).as_deref(),
        Some("4:3")
    );
    assert_eq!(
        pick_aspect(&stats(vec![("16:9", (5, 1.)), ("4:3", (5, 9.))])).as_deref(),
        Some("16:9")
    );
    assert_eq!(
        pick_aspect(&stats(vec![("16:9", (4, 9.)), ("4:3", (5, 1.))])).as_deref(),
        Some("4:3")
    );
    assert_eq!(
        pick_aspect(&stats(vec![
            ("4:3", (6, 3.)),
            ("5:4", (6, 4.5)),
            ("16:10", (5, 9.))
        ]))
        .as_deref(),
        Some("5:4")
    );
}
#[test]
fn explicit_tag_and_default_resolution() {
    let mut info = VideoInfo::default();
    assert_eq!(resolve_layout(None, &info), (None, "default"));
    info.game_aspect = Some("4:3".into());
    assert_eq!(
        resolve_layout(None, &info),
        (Some(Layout { squash: 0.75 }), "tag")
    );
    assert_eq!(
        resolve_layout(Some(Layout::default()), &info),
        (Some(Layout::default()), "explicit")
    );
}
#[test]
fn injected_positive_screens_choose_each_supported_aspect() {
    let screens = positive_screens();
    let doc: Value = serde_json::from_slice(
        &std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/modules.json"))
            .unwrap(),
    )
    .unwrap();
    for case in doc["aspect_frames"].as_array().unwrap() {
        let name = case["source_aspect"].as_str().unwrap();
        let result = choose_layout(screens.iter().map(|f| stretch(f, name)), None).unwrap();
        assert_eq!(result.found, case["found"].as_bool().unwrap(), "{name}");
        assert_eq!(result.layout.squash, case["squash"].as_f64().unwrap());
        assert_eq!(result.layout, layout::parse_aspect(name).unwrap(), "{name}");
    }
}
#[test]
fn flat_frames_and_too_few_positives_keep_default() {
    let flat = Image::new(640, 360, 1, vec![90; 640 * 360]).unwrap();
    let result = choose_layout([flat], None).unwrap();
    assert!(!result.found && result.layout.identity());
    let frame = stretch(&positive_screens()[0], "4:3");
    let result = choose_layout([frame.clone(), frame], None).unwrap();
    assert!(!result.found);
}
#[test]
fn zero_duration_and_cancel() {
    let mut info = VideoInfo::default();
    assert!(
        !detect_aspect("unused", &info, None, false, None)
            .unwrap()
            .found
    );
    info.duration = 1.;
    let cancel = AtomicBool::new(true);
    assert_eq!(
        detect_aspect("unused", &info, None, false, Some(&cancel))
            .unwrap_err()
            .to_string(),
        ""
    );
    assert_eq!(
        grab("unused", 0., true, Some(&cancel))
            .unwrap_err()
            .to_string(),
        ""
    );
}
#[test]
fn grab_drains_a_frame_larger_than_pipe_buffer() {
    let d = common::TempDir::new();
    let v = common::make_video(&d.0, "grab.mp4", 1., common::VideoOptions::default());
    let frame = grab(v.to_str().unwrap(), 0.25, false, None)
        .unwrap()
        .unwrap();
    assert_eq!(
        (frame.width, frame.height, frame.data.len()),
        (640, 360, 640 * 360)
    );
}

#[test]
fn encoded_videos_detect_each_aspect_over_the_whole_duration() {
    use std::{
        io::Write,
        process::{Command, Stdio},
        thread,
    };
    let d = common::TempDir::new();
    let screens = positive_screens();
    for (name, _) in layout::SUPPORTED_ASPECTS {
        let path = d.0.join(format!("{}.mp4", name.replace(':', "-")));
        let mut proc = Command::new(aditor::ffbin::ffmpeg().unwrap())
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
                "-s",
                "640x360",
                "-r",
                "1",
                "-i",
                "pipe:0",
                "-vf",
                "scale=1280:720",
                "-c:v",
                "libopenh264",
                "-b:v",
                "8M",
                "-allow_skip_frames",
                "0",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let frames: Vec<_> = (0..DETECT_SAMPLES)
            .map(|i| {
                if i % 3 == 0 {
                    Image::new(640, 360, 1, vec![90; 640 * 360]).unwrap()
                } else {
                    stretch(&screens[i % screens.len()], name)
                }
            })
            .collect();
        let mut stdin = proc.stdin.take().unwrap();
        let writer = thread::spawn(move || {
            for frame in frames {
                stdin.write_all(&frame.data).unwrap();
            }
        });
        let output = proc.wait_with_output().unwrap();
        writer.join().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let info = aditor::probe::probe(&path).unwrap();
        let result = detect_aspect(path.to_str().unwrap(), &info, None, false, None).unwrap();
        assert!(result.found, "{name}");
        assert_eq!(result.layout, layout::parse_aspect(name).unwrap());
        if name == "4:3" {
            assert_eq!(
                detect_layout(path.to_str().unwrap(), &info, false, None).unwrap(),
                result.layout
            );
        }
    }
}
