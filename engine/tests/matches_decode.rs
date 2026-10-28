#![cfg(windows)]
mod common;
use aditor::{ffbin, matches::VideoFrames};
use std::{path::Path, process::Command};
fn run(mode: &str) {
    if std::env::var_os("ADITOR_MATCH_STUB_CHILD").is_none() {
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", mode, "--nocapture"])
            .env("ADITOR_MATCH_STUB_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        return;
    }
    let temp = common::TempDir::new();
    let real = ffbin::ffmpeg().unwrap();
    let log = temp.0.join("args.txt");
    let stub = temp.0.join("ffmpeg.cmd");
    let content=match mode{"fallback"=>format!("echo %* | findstr /c:\"-hwaccel\" >nul\nif not errorlevel 1 exit /b 1\n\"{}\" %*\n",real.display()),"midstream"=>format!("echo %* | findstr /c:\"-hwaccel\" >nul\nif errorlevel 1 goto software\npowershell -NoProfile -NonInteractive -Command \"$b=[byte[]](@(20)*230400);[Console]::OpenStandardOutput().Write($b,0,$b.Length)\"\nexit /b 1\n:software\n\"{}\" %*\n",real.display()),"short"=>"powershell -NoProfile -NonInteractive -Command \"[Console]::OpenStandardOutput().Write([byte[]](1,2,3),0,3)\"\nexit /b 0\n".into(),_=>"powershell -NoProfile -NonInteractive -Command \"[Console]::Error.Write(('x'*131072))\"\nexit /b 1\n".into()};
    std::fs::write(
        &stub,
        format!("@echo off\necho %*>>\"{}\"\n{content}", log.display()),
    )
    .unwrap();
    std::env::set_var("ADITOR_FFMPEG", stub);
    let video =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/av1-1s-640x360-60.mp4");
    let frames = VideoFrames::new(
        video.to_str().unwrap(),
        2.,
        matches!(mode, "fallback" | "midstream"),
        "av1",
    )
    .collect::<anyhow::Result<Vec<_>>>();
    let cmds = std::fs::read_to_string(log).unwrap();
    let cmds: Vec<_> = cmds.lines().collect();
    match mode {
        "fallback" => {
            assert_eq!(
                frames.unwrap().iter().map(|f| f.0).collect::<Vec<_>>(),
                vec![0., 0.5]
            );
            assert_eq!(cmds.len(), 3);
            assert!(cmds[0].contains("format=nv12"));
            assert!(cmds[1].contains("format=p010le"));
            assert!(!cmds[2].contains("-hwaccel"));
        }
        "midstream" => {
            let frames = frames.unwrap();
            assert_eq!(
                frames.iter().map(|f| f.0).collect::<Vec<_>>(),
                vec![0., 0.5]
            );
            assert!(frames[0].1.data.iter().all(|&v| v == 20));
            assert_eq!(cmds.len(), 2);
            assert!(cmds[1].contains("-ss 0.500"));
            assert!(!cmds[1].contains("-hwaccel"));
        }
        "short" => {
            assert!(frames
                .unwrap_err()
                .to_string()
                .contains("frame bytes 3/230400"));
        }
        _ => {
            let err = frames.unwrap_err();
            let tail = &err
                .downcast_ref::<aditor::decode::DecodeError>()
                .unwrap()
                .stderr_tail;
            assert_eq!(tail.len(), aditor::decode::STDERR_LIMIT);
        }
    }
}
#[test]
fn fallback() {
    run("fallback");
}
#[test]
fn midstream() {
    run("midstream");
}
#[test]
fn short() {
    run("short");
}
#[test]
fn failed_software() {
    run("failed_software");
}
