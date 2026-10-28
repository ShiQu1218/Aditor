mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{
    analyze::{self, AnalyzeOptions},
    cv::Image,
    layout::Layout,
};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
fn video(path: &Path, width: usize, height: usize, fmt: &str, fps: usize, frames: Vec<Vec<u8>>) {
    let mut child = Command::new(aditor::ffbin::ffmpeg().unwrap())
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            fmt,
            "-s",
            &format!("{width}x{height}"),
            "-r",
            &fps.to_string(),
            "-i",
            "pipe:0",
            "-c:v",
            "ffv1",
        ])
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for f in frames {
        input.write_all(&f).unwrap();
    }
    drop(input);
    assert!(child.wait().unwrap().success());
}
#[test]
fn matches_cli_and_api_with_and_without_timeline_match_python() {
    let c = &parity::cases()["matches_video"];
    let temp = common::TempDir::new();
    let path = temp.0.join("matches.mkv");
    let frames = c["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| parity::screen(f.as_str().unwrap()).data)
        .collect();
    video(&path, 640, 360, "gray", 1, frames);
    for timeline in [false, true] {
        let doc = aditor::matches::analyze_matches(
            path.to_str().unwrap(),
            1.,
            timeline,
            false,
            Some(Layout::default()),
            None,
        )
        .unwrap();
        parity::close(&doc, &c["expected"][usize::from(timeline)]);
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_aditor"));
        cmd.arg("matches")
            .arg(&path)
            .args([
                "--fps",
                "1",
                "--no-hwaccel",
                "--aspect",
                "16:9",
                "--scene-dir",
            ])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/scene"));
        if timeline {
            cmd.arg("--timeline");
        }
        let out = cmd.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let got: Value = serde_json::from_slice(&out.stdout).unwrap();
        parity::close(&got, &doc);
        let mut expected = aditor::cache::json_bytes(&doc).unwrap();
        expected.push(b'\n');
        assert_eq!(out.stdout, expected);
    }
}
fn portable(mut doc: Value) -> Value {
    doc.as_object_mut().unwrap().remove("cache_path");
    let v = doc["video"].as_object_mut().unwrap();
    v.remove("path");
    v.remove("mtime");
    doc
}
#[test]
fn real_valorant_dispatch_and_cache_preservation_match_python() {
    let c = &parity::cases()["valorant_video"];
    let temp = common::TempDir::new();
    let path = temp.0.join("valorant.mkv");
    let board = parity::image(c["board"].as_str().unwrap());
    let frames = c["feeds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            let feed = parity::image(id.as_str().unwrap());
            let mut frame = Image::new(1920, 1080, 3, vec![0; 1920 * 1080 * 3]).unwrap();
            for (im, x, y) in [(&feed, 1316, 84), (&board, 740, 20)] {
                for yy in 0..im.height {
                    let a = ((y + yy) * 1920 + x) * 3;
                    frame.data[a..a + im.width * 3]
                        .copy_from_slice(&im.data[yy * im.width * 3..(yy + 1) * im.width * 3]);
                }
            }
            frame.data
        })
        .collect();
    video(&path, 1920, 1080, "bgr24", 4, frames);
    let p = common::profile();
    let opts = || AnalyzeOptions {
        game: Some("valorant"),
        layout: Some(Layout::default()),
        hwaccel: false,
        force: true,
        ..AnalyzeOptions::new(&temp.0)
    };
    let mut doc = analyze::analyze(path.to_str().unwrap(), &p, opts()).unwrap();
    let mut expected = c["expected"].clone();
    expected["analysis"]["aspect_source"] = "explicit".into();
    parity::close(&portable(doc.clone()), &expected);
    let cache = doc["cache_path"].as_str().unwrap().to_owned();
    doc["events"][0]["deleted"] = true.into();
    std::fs::write(&cache, serde_json::to_vec(&doc).unwrap()).unwrap();
    let redone = analyze::analyze(path.to_str().unwrap(), &p, opts()).unwrap();
    assert_eq!(redone["events"][0]["deleted"], true);
    assert_eq!(redone["game"], json!("valorant"));
}
#[test]
fn control_video_live_and_segmented_offline_share_immediate_kills() {
    let c = &parity::cases()["control_video"];
    let temp = common::TempDir::new();
    let path = temp.0.join("control.mkv");
    let frames = c["times"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let key = format!("{:?}", t.as_f64().unwrap()).replace('.', "_");
            let mut frame = Image::new(1920, 1080, 3, vec![0; 1920 * 1080 * 3]).unwrap();
            for (kind, x, y) in [("feed", 850, 60), ("spec", 60, 950)] {
                let im = aditor::cv::read_png(
                    &parity::root().join(format!("fixtures/control_feed/{key}_{kind}.png")),
                    false,
                )
                .unwrap();
                for yy in 0..im.height {
                    let a = ((y + yy) * 1920 + x) * 3;
                    frame.data[a..a + im.width * 3]
                        .copy_from_slice(&im.data[yy * im.width * 3..(yy + 1) * im.width * 3]);
                }
            }
            frame.data
        })
        .collect();
    video(&path, 1920, 1080, "bgr24", 1, frames);
    let p = common::profile();
    for jobs in [1, 2] {
        let opts = AnalyzeOptions {
            game: Some("apex"),
            layout: Some(Layout::default()),
            hwaccel: false,
            force: true,
            jobs: Some(jobs),
            ..AnalyzeOptions::new(&temp.0)
        };
        let doc = analyze::analyze(path.to_str().unwrap(), &p, opts).unwrap();
        parity::close(&portable(doc), &c["expected"][jobs - 1]);
    }
    let mut live = aditor::live::LiveKills::new(&p, Default::default()).unwrap();
    let mut stream = aditor::decode::FrameStream::new(
        path.to_str().unwrap(),
        p,
        aditor::decode::DecodeOptions {
            hwaccel: false,
            ..Default::default()
        },
    );
    while let Some(frame) = stream.next() {
        let (t, b, s) = frame.unwrap();
        live.feed(
            t,
            &b,
            &s,
            stream.killfeed.as_ref(),
            if ((t * 4.).round_ties_even() as usize).is_multiple_of(4) {
                stream.thumb.as_ref()
            } else {
                None
            },
        )
        .unwrap();
    }
    let (e, _) = live.finish().unwrap();
    parity::close(&json!(e), &c["expected"][0]["events"]);
}
