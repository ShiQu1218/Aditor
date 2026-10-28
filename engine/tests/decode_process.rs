#![cfg(windows)]
mod common;
use aditor::{
    decode::{DecodeOptions, FrameStream, STDERR_LIMIT},
    ffbin,
};
use common::TempDir;
use std::{path::Path, process::Command};

fn child(test: &str, fail_software: bool) {
    if std::env::var_os("ADITOR_DECODE_STUB_CHILD").is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env("ADITOR_DECODE_STUB_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let d = TempDir::new();
    let real = ffbin::ffmpeg().unwrap();
    let log = d.0.join("commands.txt");
    let stub = d.0.join("ffmpeg.cmd");
    let fail = if fail_software {
        "goto fail"
    } else {
        "echo %* | findstr /c:\"-hwaccel\" >nul\nif not errorlevel 1 goto fail"
    };
    std::fs::write(&stub,format!("@echo off\necho %*>>\"{}\"\n{fail}\n\"{}\" %*\nexit /b %errorlevel%\n:fail\npowershell -NoProfile -NonInteractive -Command \"[Console]::Error.Write(('x'*131072))\"\nexit /b 1\n",log.display(),real.display())).unwrap();
    std::env::set_var("ADITOR_FFMPEG", &stub);
    let video =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/av1-1s-640x360-60.mp4");
    let mut fs = FrameStream::new(
        video.to_str().unwrap(),
        common::profile(),
        DecodeOptions {
            codec: Some("av1".into()),
            ..Default::default()
        },
    );
    if fail_software {
        let error = fs.next().unwrap().unwrap_err();
        assert_eq!(error.message, "ffmpeg decoding failed");
        assert_eq!(error.stderr_tail.len(), STDERR_LIMIT);
        assert!(error.stderr_tail.bytes().all(|b| b == b'x'));
        assert!(fs.next().is_none());
    } else {
        assert_eq!(
            fs.by_ref().map(|f| f.unwrap().0).collect::<Vec<_>>(),
            vec![0., 0.25, 0.5, 0.75]
        );
    }
    assert!(!fs.used_hwaccel);
    let log = std::fs::read_to_string(log).unwrap();
    let commands: Vec<_> = log.lines().collect();
    assert_eq!(commands.len(), 3, "{log}");
    assert!(commands[0].contains("format=nv12") && commands[0].contains("-c:v av1"));
    assert!(commands[1].contains("format=p010le"));
    assert!(
        !commands[2].contains("-hwaccel")
            && !commands[2].contains("-c:v")
            && !commands[2].contains("hwdownload")
    );
}
#[test]
fn first_frame_failure_retries_ten_bit_then_software() {
    child("first_frame_failure_retries_ten_bit_then_software", false);
}
#[test]
fn stderr_flood_keeps_only_tail_without_deadlock() {
    child("stderr_flood_keeps_only_tail_without_deadlock", true);
}
