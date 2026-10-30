use super::*;
use std::path::Path;
fn profile() -> Profile {
    crate::profile::load_profile(Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/icons"))
        .unwrap()
}
#[test]
fn stacked_buffer_is_reused_without_changing_or_overwriting_outputs() {
    for aspect in ["16:9", "16:10", "4:3", "5:4"] {
        let p = profile().with_layout(crate::layout::parse_aspect(aspect).unwrap());
        let mut stream = FrameStream::new(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/media/av1-1s-640x360-60.mp4")
                .to_str()
                .unwrap(),
            p.clone(),
            DecodeOptions {
                hwaccel: false,
                ..Default::default()
            },
        );
        let first = stream.next().unwrap().unwrap();
        let ([_, _, bw, bh], [_, _, sw, sh]) = stream.rects();
        let arr = &stream.stacked;
        let expected = p
            .restore(
                &arr.crop(0, 0, bw as usize, bh as usize).unwrap(),
                &arr.crop(0, bh as usize, sw as usize, sh as usize).unwrap(),
            )
            .unwrap();
        assert_eq!((&first.1, &first.2), (&expected.0, &expected.1));
        let [_, _, fw, fh] = p.capture_killfeed().unwrap();
        let feed = p
            .restore_killfeed(
                &arr.crop(0, (bh + sh) as usize, fw as usize, fh as usize)
                    .unwrap(),
            )
            .unwrap();
        let thumb = cv::gray(&arr.crop(0, arr.height - 360, 640, 360).unwrap()).unwrap();
        assert_eq!(stream.killfeed.as_ref(), Some(&feed));
        assert_eq!(stream.thumb.as_ref(), Some(&thumb));
        let allocation = arr.data.as_ptr();
        stream.next().unwrap().unwrap();
        assert_eq!(stream.stacked.data.as_ptr(), allocation);
        assert_eq!((first.1, first.2), expected);
        assert_eq!(first.0, 0.);
    }
}

#[test]
#[cfg(windows)]
fn hardware_mid_stream_failure_resumes_grid_without_pixel_format_retry() {
    let p = profile();
    let [_, _, bw, bh] = p.capture_banner();
    let [_, _, sw, sh] = p.capture_spec();
    let [_, _, fw, fh] = p.capture_killfeed().unwrap();
    let bytes = bw.max(sw).max(fw) * (bh + sh + fh + 360) * 3;
    let v =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/av1-1s-640x360-60.mp4");
    let mut fs = FrameStream::new(
        v.to_str().unwrap(),
        p,
        DecodeOptions {
            codec: Some("av1".into()),
            ..Default::default()
        },
    );
    fs.plans.pop_front();
    fs.proc=Some(crate::process::spawn(Command::new("powershell").args(["-NoProfile","-NonInteractive","-Command",&format!("$out=[Console]::OpenStandardOutput(); $out.Write([byte[]]::new({bytes}),0,{bytes}); $out.Flush(); exit 1")]).stdout(Stdio::piped()).stderr(Stdio::null())).unwrap());
    let ts: Vec<_> = fs.by_ref().map(|f| f.unwrap().0).collect();
    assert_eq!(ts, vec![0., 0.25, 0.5, 0.75]);
    assert!(!fs.used_hwaccel);
    assert!(fs.proc.is_none() && fs.reader.is_none());
}
#[test]
#[cfg(windows)]
fn software_mid_stream_failure_is_not_silently_successful() {
    let p = profile();
    let [_, _, bw, bh] = p.capture_banner();
    let [_, _, sw, sh] = p.capture_spec();
    let [_, _, fw, fh] = p.capture_killfeed().unwrap();
    let bytes = bw.max(sw).max(fw) * (bh + sh + fh + 360) * 3;
    let mut fs = FrameStream::new(
        "unused",
        p,
        DecodeOptions {
            hwaccel: false,
            ..Default::default()
        },
    );
    fs.plans.clear();
    fs.proc=Some(crate::process::spawn(Command::new("powershell").args(["-NoProfile","-NonInteractive","-Command",&format!("$out=[Console]::OpenStandardOutput(); $out.Write([byte[]]::new({bytes}),0,{bytes}); $out.Write([byte[]]::new(100),0,100); $out.Flush(); exit 7")]).stdout(Stdio::piped()).stderr(Stdio::null())).unwrap());
    fs.next().unwrap().unwrap();
    let error = fs.next().unwrap().unwrap_err();
    assert_eq!(error.message, "ffmpeg exited unexpectedly (7)");
    assert!(fs.next().is_none());
}
