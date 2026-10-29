//! Verify stdin/stdout JSON-lines and EOF shutdown behavior of the actual aditorrec child process.

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

#[test]
fn executable_replies_with_json_only_and_exits_on_stdin_eof() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_aditorrec"))
        .env_remove("ADITORREC_DIAGNOSTICS")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(
        b"\r\n{\"id\":1,\"cmd\":\"hello\"}\n{\"id\":2,\"cmd\":\"ping\"}\n{\"id\":3,\"cmd\":\"unknown\"}\ninvalid\n{\"id\":4,\"cmd\":\"stop\"}",
    ).unwrap();
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.ends_with(b"\n"));
    let lines: Vec<Value> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 5);
    assert_eq!(lines[0]["id"], 1);
    assert_eq!(lines[0]["ok"], true);
    assert_eq!(lines[0]["version"], env!("CARGO_PKG_VERSION"));
    assert!(lines[0]["encoders"].is_array());
    assert!(lines[0]["gpus"].is_array());
    assert!(lines[0]["audio"]["render"].is_array());
    assert!(lines[0]["audio"]["capture"].is_array());
    assert_eq!(lines[1], json!({"id":2,"ok":true}));
    assert_eq!(lines[2]["id"], 3);
    assert_eq!(lines[2]["code"], "bad_request");
    assert_eq!(lines[3]["id"], 0);
    assert_eq!(lines[3]["code"], "bad_request");
    assert_eq!(lines[4], json!({"id":4,"ok":true}));
}

#[test]
fn opt_in_probe_progress_stays_on_stderr_and_stdout_remains_json() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_aditorrec"))
        .env("ADITORREC_DIAGNOSTICS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"id\":1,\"cmd\":\"hello\"}\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let lines: Vec<Value> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["id"], 1);
    assert_eq!(lines[0]["ok"], true);
    let log = std::str::from_utf8(&output.stderr).unwrap();
    assert!(log.starts_with("ADITORREC_DIAG probe_stage=gpu_enumerate probe_encoder=none\n"));
    assert!(log.ends_with("ADITORREC_DIAG probe_stage=ready probe_encoder=none\n"));
    for line in log.lines() {
        let marker = line.strip_prefix("ADITORREC_DIAG probe_stage=").unwrap();
        let (stage, encoder) = marker.split_once(" probe_encoder=").unwrap();
        assert!([
            "gpu_enumerate",
            "gpu_create",
            "probe_open",
            "probe_copy",
            "probe_send",
            "probe_flush",
            "probe_close",
            "audio_devices",
            "ready"
        ]
        .contains(&stage));
        assert!(
            encoder == "none"
                || ["hevc", "h264", "av1"]
                    .iter()
                    .any(|codec| ["nvenc", "amf", "qsv"]
                        .iter()
                        .any(|family| encoder == format!("{codec}_{family}")))
        );
    }
}
