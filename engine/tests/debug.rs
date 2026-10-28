mod common;
use serde_json::Value;
use std::{path::Path, process::Command};

#[test]
fn evaluation_commands_decode_json_lines_and_reject_invalid_ranges() {
    let temp = common::TempDir::new();
    let video = common::make_video(&temp.0, "debug.mp4", 0.5, Default::default());
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for (command, profile) in [
        ("debug-benchmark", "../templates/icons"),
        ("debug-valorant-feed", "../templates/valorant/icons"),
    ] {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_aditor"));
        cmd.arg(command)
            .arg(&video)
            .arg("--profile-dir")
            .arg(root.join(profile));
        if command == "debug-benchmark" {
            cmd.args(["--seconds", "0.5", "--no-hwaccel"]);
        }
        let out = cmd.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let lines: Vec<Value> = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        if command == "debug-benchmark" {
            assert_eq!(lines.len(), 1);
            assert_eq!(lines[0]["frames"], 2);
            assert_eq!(lines[0]["used_hwaccel"], false);
            assert!(lines[0]["detection_s"].as_f64().unwrap() > 0.);
        } else {
            assert_eq!(lines.len(), 2);
            assert_eq!(lines[1]["t"], 0.25);
            assert!(lines[0]["observations"].is_array());
            assert!(lines[0]["events"].is_array());
        }
    }
    let out = Command::new(env!("CARGO_BIN_EXE_aditor"))
        .arg("debug-benchmark")
        .arg(&video)
        .arg("--profile-dir")
        .arg(root.join("../templates/icons"))
        .args(["--decode-only", "--no-hwaccel"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["frames"], 2);
    assert_eq!(result["detection_s"], 0.);
    for seconds in ["-1", "NaN", "inf"] {
        let out = Command::new(env!("CARGO_BIN_EXE_aditor"))
            .args([
                "debug-benchmark",
                "unused",
                "--profile-dir",
                "unused",
                "--seconds",
                seconds,
            ])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert!(String::from_utf8_lossy(&out.stderr).contains("finite"));
    }
}
