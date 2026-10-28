mod common;
use aditor::{cv, decode::*, layout::parse_aspect};
use common::{make_video, TempDir, VideoOptions};
use std::path::Path;
fn times(path: &Path, options: DecodeOptions) -> Vec<f64> {
    FrameStream::new(path.to_str().unwrap(), common::profile(), options)
        .map(|f| f.unwrap().0)
        .collect()
}
#[test]
fn input_args_keep_thread_budget_and_decoder_before_seek() {
    let threads = [
        "-threads",
        "2",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
    ]
    .map(str::to_owned)
    .to_vec();
    let gpu = ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"]
        .map(str::to_owned)
        .to_vec();
    let mut expected = threads.clone();
    expected.extend(gpu.clone());
    expected.extend(["-c:v", "av1", "-ss", "2.500"].map(str::to_owned));
    assert_eq!(build_input_args(Some("av1"), true, 2.5), expected);
    for codec in ["h264", "hevc", "vp9"] {
        let mut expected = threads.clone();
        expected.extend(gpu.clone());
        assert_eq!(build_input_args(Some(codec), true, 0.), expected);
    }
    for codec in [None, Some("mpeg4")] {
        let mut expected = threads.clone();
        expected.extend(["-hwaccel", "auto"].map(str::to_owned));
        assert_eq!(build_input_args(codec, true, 0.), expected);
    }
    assert_eq!(build_input_args(Some("av1"), false, 0.), threads);
    assert!(is_gpu_path(Some("av1"), true) && is_gpu_path(Some("h264"), true));
    assert!(
        !is_gpu_path(None, true)
            && !is_gpu_path(Some("av1"), false)
            && !is_gpu_path(Some("mpeg4"), true)
    );
}
#[test]
fn filter_downloads_after_sampling_and_changes_only_prefix() {
    let p = common::profile();
    let gpu = build_filter(&p, true, "nv12");
    let soft = build_filter(&p, false, "nv12");
    assert!(
        gpu.starts_with("[0:v]fps=4,hwdownload,format=nv12,format=yuv420p,scale=1920:1080,split")
    );
    assert!(
        build_filter(&p, true, "p010le").contains("hwdownload,format=p010le,format=yuv420p10le,")
    );
    assert_eq!(
        gpu.split_once("split").unwrap().1,
        soft.split_once("split").unwrap().1
    );
    assert!(!soft.contains("hwdownload"));
    let mut p = p;
    p.killfeed_roi = None;
    assert!(build_filter(&p, false, "nv12").ends_with("[a1][b1]vstack"));
}
#[test]
fn frame_times_shapes_and_end_limit() {
    let d = TempDir::new();
    let v = make_video(&d.0, "中文 路徑.mp4", 3., VideoOptions::default());
    let mut stream = FrameStream::new(
        v.to_str().unwrap(),
        common::profile(),
        DecodeOptions {
            hwaccel: false,
            ..Default::default()
        },
    );
    let first = stream.next().unwrap().unwrap();
    assert_eq!(first.0, 0.);
    assert_eq!(
        (first.1.width, first.1.height, first.1.channels),
        (800, 180, 3)
    );
    assert_eq!(
        (first.2.width, first.2.height, first.2.channels),
        (480, 118, 3)
    );
    assert!(stream.killfeed.is_some() && stream.thumb.is_some());
    let rest: Vec<_> = stream.map(|f| f.unwrap().0).collect();
    assert_eq!(rest, (1..12).map(|i| i as f64 / 4.).collect::<Vec<_>>());
    assert_eq!(
        times(
            &v,
            DecodeOptions {
                start: 1.,
                end: Some(2.),
                hwaccel: false,
                ..Default::default()
            }
        ),
        vec![1., 1.25, 1.5, 1.75]
    );
}
#[test]
fn marks_align_for_offset_vfr_and_resume() {
    let d = TempDir::new();
    for (offset, vfr, start) in [(5., false, 0.), (0., true, 0.), (0., false, 2.)] {
        let v = make_video(
            &d.0,
            "marks.mp4",
            6.,
            VideoOptions {
                start_time: offset,
                vfr,
                marks: &[(3., 3.6)],
                ..Default::default()
            },
        );
        let lit: Vec<_> = FrameStream::new(
            v.to_str().unwrap(),
            common::profile(),
            DecodeOptions {
                start,
                hwaccel: false,
                ..Default::default()
            },
        )
        .map(|f| f.unwrap())
        .filter(|(_, b, _)| {
            b.data.iter().map(|&v| v as f64).sum::<f64>() / b.data.len() as f64 > 200.
        })
        .map(|f| f.0)
        .collect();
        assert!((lit[0] - 3.).abs() <= 0.25);
    }
}
#[test]
fn bad_file_errors_include_bounded_stderr() {
    let d = TempDir::new();
    let p = d.0.join("bad.mp4");
    std::fs::write(&p, b"garbage").unwrap();
    let mut stream = FrameStream::new(
        p.to_str().unwrap(),
        common::profile(),
        DecodeOptions {
            codec: Some("h264".into()),
            ..Default::default()
        },
    );
    let e = stream.next().unwrap().unwrap_err();
    assert_eq!(e.message, "ffmpeg decoding failed");
    assert!(!e.stderr_tail.is_empty());
    assert!(e.stderr_tail.len() <= STDERR_LIMIT);
    assert!(stream.next().is_none());
    assert!(!stream.used_hwaccel);
}
#[test]
fn close_is_idempotent_and_stops_iteration() {
    let d = TempDir::new();
    let v = make_video(&d.0, "close.mp4", 2., VideoOptions::default());
    let mut fs = FrameStream::new(
        v.to_str().unwrap(),
        common::profile(),
        DecodeOptions {
            hwaccel: false,
            ..Default::default()
        },
    );
    fs.next().unwrap().unwrap();
    fs.close();
    fs.close();
    assert!(fs.next().is_none());
}
#[test]
fn av1_hw_or_fallback_preserves_frames() {
    let v =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/av1-1s-640x360-60.mp4");
    let mut hw = FrameStream::new(
        v.to_str().unwrap(),
        common::profile(),
        DecodeOptions {
            codec: Some("av1".into()),
            ..Default::default()
        },
    );
    let frames: Vec<_> = hw.by_ref().map(|f| f.unwrap()).collect();
    assert_eq!(frames.len(), 4);
    let soft: Vec<_> = FrameStream::new(
        v.to_str().unwrap(),
        common::profile(),
        DecodeOptions {
            codec: Some("av1".into()),
            hwaccel: false,
            ..Default::default()
        },
    )
    .map(|f| f.unwrap())
    .collect();
    assert_eq!(frames, soft);
}
#[test]
fn stretched_banner_restores_reference() {
    let d = TempDir::new();
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/en/pos/knock_a002500.png");
    let banner = cv::read_png(&fixture, false)
        .unwrap()
        .crop(0, 0, 800, 180)
        .unwrap();
    let png = d.0.join("banner.png");
    cv::write_png(&png, &banner).unwrap();
    let v = make_video(
        &d.0,
        "stretched.mp4",
        1.,
        VideoOptions {
            overlay: Some((&png, &[(0., 1.)])),
            game_height: Some(1440),
            ..Default::default()
        },
    );
    let p = common::profile();
    let got = FrameStream::new(
        v.to_str().unwrap(),
        p.with_layout(parse_aspect("4:3").unwrap()),
        DecodeOptions {
            hwaccel: false,
            ..Default::default()
        },
    )
    .next()
    .unwrap()
    .unwrap()
    .1;
    let plain = FrameStream::new(
        v.to_str().unwrap(),
        p,
        DecodeOptions {
            hwaccel: false,
            ..Default::default()
        },
    )
    .next()
    .unwrap()
    .unwrap()
    .1;
    assert!(cv::match_template(&got, &banner, None).unwrap().data[0] > 0.8);
    assert!(cv::match_template(&plain, &banner, None).unwrap().data[0] < 0.8);
}

#[test]
fn ten_bit_hevc_hardware_when_available() {
    let d = TempDir::new();
    let v = d.0.join("ten-bit.mp4");
    let result = std::process::Command::new(aditor::ffbin::ffmpeg().unwrap())
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=60:duration=2",
            "-pix_fmt",
            "p010le",
            "-c:v",
            "hevc_nvenc",
            "-profile:v",
            "main10",
        ])
        .arg(&v)
        .output()
        .unwrap();
    if !result.status.success() {
        eprintln!(
            "SKIP hardware assertion: hevc_nvenc unavailable: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    let mut stream = FrameStream::new(
        v.to_str().unwrap(),
        common::profile(),
        DecodeOptions {
            codec: Some("hevc".into()),
            ..Default::default()
        },
    );
    let mut count = 0;
    for frame in stream.by_ref() {
        frame.unwrap();
        count += 1;
    }
    assert_eq!(count, 8);
    if !stream.used_hwaccel {
        eprintln!(
            "SKIP hardware assertion: D3D11VA unavailable; software fallback produced all 8 frames"
        );
    } else {
        println!("10-bit HEVC decoded with D3D11VA");
    }
}

#[test]
fn omitting_feed_and_thumbnail_keeps_calibration_crops_exact() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/media/knocks.mp4");
    let p = common::profile();
    assert!(p.killfeed_roi.is_some());
    let options = DecodeOptions {
        end: Some(1.),
        hwaccel: false,
        ..Default::default()
    };
    let expected: Vec<_> = FrameStream::new(path.to_str().unwrap(), p.clone(), options.clone())
        .map(Result::unwrap)
        .collect();
    let mut calibration = p;
    calibration.killfeed_roi = None;
    let mut stream = FrameStream::new(path.to_str().unwrap(), calibration, options);
    let actual: Vec<_> = stream.by_ref().map(Result::unwrap).collect();
    assert!(!actual.is_empty());
    assert_eq!(actual, expected);
    assert!(stream.killfeed.is_none() && stream.thumb.is_none());
}
