mod common;
use aditor::{ffbin, probe::*};
use common::{make_video, TempDir, VideoOptions};
use serde_json::json;
use std::process::Command;
#[test]
fn aspect_ratio_tolerance() {
    assert!(is_16x9(1920, 1080) && is_16x9(1916, 1080));
    assert!(!is_16x9(1728, 1080) && !is_16x9(1440, 1080) && !is_16x9(1, 0));
}
#[test]
fn average_frame_rate_and_fallback() {
    for (avg, real, expected) in [
        (json!("144/1"), "144/1", 144.),
        (json!("30000/1001"), "60/1", 30000. / 1001.),
        (json!("0/0"), "120/1", 120.),
        (json!("0/0"), "0/0", 0.),
        (json!(null), "bad", 0.),
    ] {
        assert!(
            (frame_rate(&json!({"avg_frame_rate":avg,"r_frame_rate":real})) - expected).abs()
                < 1e-10
        );
    }
    for v in ["", "bad", "0/0", "-1/2", "1/-2"] {
        assert_eq!(rate(Some(&json!(v))), 0.);
    }
}
#[test]
fn start_time_unicode_and_keyframes() {
    let d = TempDir::new();
    let v = make_video(
        &d.0,
        "空白 名稱.mp4",
        4.,
        VideoOptions {
            start_time: 5.,
            ..Default::default()
        },
    );
    let info = probe(&v).unwrap();
    assert_eq!((info.width, info.height), (1920, 1080));
    assert!((info.start_time - 5.).abs() < 0.1);
    assert!((info.duration - 4.).abs() < 0.2);
    assert!((info.fps - 60.).abs() < 0.01);
    assert_eq!(info.pix_fmt, "yuv420p");
    let kf = keyframes(&v).unwrap();
    assert!(kf[0].abs() < 0.05 && (kf[1] - 1.).abs() < 0.05);
}
#[test]
fn aspect_tags() {
    let d = TempDir::new();
    for aspect in [None, Some("1920x1440")] {
        let v = make_video(
            &d.0,
            "aspect.mp4",
            0.5,
            VideoOptions {
                game_aspect: aspect,
                ..Default::default()
            },
        );
        assert_eq!(probe(v).unwrap().game_aspect.as_deref(), aspect);
    }
    let path = d.0.join("mock.mp4");
    std::fs::write(&path, []).unwrap();
    let info=from_document(path.to_str().unwrap(),&json!({"streams":[{"width":1920,"height":1080}],"format":{"duration":"1","tags":{"ADITOR_GAME_ASPECT":"1920x1440","ADITOR_GAME":"valorant","not_string":1}}})).unwrap();
    assert_eq!(info.game_aspect.as_deref(), Some("1920x1440"));
    assert_eq!(info.game.as_deref(), Some("valorant"));
}
#[test]
fn bad_files_and_missing_video() {
    let d = TempDir::new();
    let p = d.0.join("bad.mp4");
    std::fs::write(&p, b"not a video").unwrap();
    assert!(probe(p).is_err());
    assert_eq!(
        from_document("unused", &json!({})).unwrap_err().to_string(),
        "No video stream found"
    );
}
#[test]
fn keyframes_use_container_start_when_video_is_late() {
    let d = TempDir::new();
    let out = d.0.join("late.mkv");
    let result = Command::new(ffbin::ffmpeg().unwrap())
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=4",
            "-itsoffset",
            "0.5",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30:duration=3",
            "-map",
            "1:v",
            "-map",
            "0:a",
            "-c:v",
            "libopenh264",
            "-b:v",
            "4M",
            "-allow_skip_frames",
            "0",
            "-g",
            "30",
            "-c:a",
            "aac",
        ])
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let kf = keyframes(out).unwrap();
    assert!((kf[0] - 0.5).abs() < 0.05 && (kf[1] - 1.5).abs() < 0.05);
}
