use super::*;
use std::path::Path;
fn profile() -> Profile {
    crate::profile::load_profile(Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/icons"))
        .unwrap()
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
    fs.proc=Some(crate::process::spawn(Command::new("powershell").args(["-NoProfile","-NonInteractive","-Command",&format!("$out=[Console]::OpenStandardOutput(); $out.Write([byte[]]::new({bytes}),0,{bytes}); $out.Flush(); exit 7")]).stdout(Stdio::piped()).stderr(Stdio::null())).unwrap());
    fs.next().unwrap().unwrap();
    let error = fs.next().unwrap().unwrap_err();
    assert_eq!(error.message, "ffmpeg exited unexpectedly (7)");
    assert!(fs.next().is_none());
}
