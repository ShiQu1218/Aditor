//! Verify stdin/stdout JSON-lines and EOF shutdown behavior of the actual aditorrec child process.

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

#[test]
fn executable_replies_with_json_only_and_exits_on_stdin_eof() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_aditorrec"))
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
