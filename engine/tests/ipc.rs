mod common;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};
struct Server {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<Value>,
}
impl Server {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_aditor"))
            .arg("ipc")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                let value = serde_json::from_str(&line).unwrap();
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        let s = Self {
            child,
            input,
            output,
        };
        assert_eq!(
            s.next(),
            json!({"type":"ready","engine_version":aditor::cache::ENGINE_VERSION})
        );
        s
    }
    fn raw(&mut self, raw: &str) {
        writeln!(self.input.as_mut().unwrap(), "{raw}").unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
    }
    fn send(&mut self, id: &str, cmd: &str, args: Value) {
        self.raw(&json!({"id":id,"cmd":cmd,"args":args}).to_string());
    }
    fn next(&self) -> Value {
        self.output
            .recv_timeout(Duration::from_secs(60))
            .expect("IPC response timed out")
    }
    fn terminal(&self, id: &str) -> Value {
        loop {
            let v = self.next();
            assert_eq!(v["id"], id);
            if v["type"] != "progress" {
                return v;
            }
            assert!(v["t"].as_f64().unwrap() <= v["duration"].as_f64().unwrap());
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn args(tmp: &common::TempDir) -> Value {
    json!({"path":std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/media/knocks.mp4"),"profile_dir":common::profile().dir,"cache_dir":tmp.0,"hwaccel":false,"game":"apex","aspect":"16:9","jobs":1})
}
#[test]
fn ready_probe_and_errors_are_isolated() {
    let mut s = Server::new();
    let tmp = common::TempDir::new();
    s.send("probe", "probe", args(&tmp));
    assert_eq!(s.next()["data"]["duration"], 12.);
    for (raw, id, message) in [
        ("[]", Value::Null, "Request must be a JSON object"),
        (
            r#"{"id":3,"cmd":"probe"}"#,
            json!(3),
            "id must be a string and args must be an object",
        ),
        (
            r#"{"id":"bad","cmd":"unknown"}"#,
            json!("bad"),
            "Unknown command: 'unknown'",
        ),
        (
            r#"{"id":"missing","cmd":"probe"}"#,
            json!("missing"),
            "Missing parameter: path",
        ),
    ] {
        s.raw(raw);
        let v = s.next();
        assert_eq!(v["id"], id);
        assert_eq!(v["code"], "bad_request");
        assert_eq!(v["message"], message);
        assert_eq!(v["exception"]["type"], "BadRequest");
        assert!(v["exception"]["frames"].is_array());
    }
    s.raw("{");
    assert_eq!(s.next()["code"], "bad_request");
    s.send("good", "probe", args(&tmp));
    assert_eq!(s.next()["type"], "result");
    s.send(
        "missing-file",
        "probe",
        json!({"path":tmp.0.join("missing.mp4")}),
    );
    assert_eq!(s.next()["code"], "probe_failed");
    let mut invalid = args(&tmp);
    invalid["profile_dir"] = tmp.0.to_str().unwrap().into();
    s.send("profile", "analyze", invalid);
    assert_eq!(s.terminal("profile")["code"], "profile_error");
    let mut invalid = args(&tmp);
    invalid["game"] = "unknown".into();
    s.send("game", "analyze", invalid);
    assert_eq!(s.terminal("game")["code"], "unsupported_game");
    let mut valorant = args(&tmp);
    valorant["game"] = "valorant".into();
    s.send("phase-c", "analyze", valorant);
    let result = s.terminal("phase-c");
    assert_eq!(result["type"], "result");
    assert_eq!(result["data"]["game"], "valorant");
}
#[test]
fn busy_cancel_and_eof_wait_for_the_worker() {
    let mut s = Server::new();
    let tmp = common::TempDir::new();
    let a = args(&tmp);
    s.send("running", "analyze", a.clone());
    s.send("busy", "analyze", a);
    s.send("cancel", "cancel", json!({"target":"running"}));
    let mut messages = vec![];
    while messages.len() < 3 {
        let v = s.next();
        if v["type"] != "progress" {
            messages.push(v);
        }
    }
    assert!(messages
        .iter()
        .any(|v| v["id"] == "busy" && v["code"] == "busy"));
    assert!(messages
        .iter()
        .any(|v| v["id"] == "cancel" && v["data"]["cancelled"] == true));
    assert!(messages
        .iter()
        .any(|v| v["id"] == "running" && v["code"] == "cancelled"));
    s.send("absent", "cancel", json!({"target":"running"}));
    assert_eq!(s.next()["data"]["cancelled"], false);
    s.send("eof", "analyze", args(&tmp));
    s.input.take();
    assert_eq!(s.terminal("eof")["code"], "cancelled");
    assert!(s.child.wait().unwrap().success());
}
#[test]
fn terminal_response_releases_busy_and_cache_is_reusable() {
    let mut s = Server::new();
    let tmp = common::TempDir::new();
    let a = args(&tmp);
    s.send("one", "analyze", a.clone());
    let one = s.terminal("one");
    assert_eq!(one["type"], "result");
    s.send("two", "analyze", a);
    assert_eq!(s.terminal("two")["data"], one["data"]);
}
#[test]
fn jobs_and_layout_validation() {
    for value in [json!(false), json!(0), json!(-1), json!(1.5), json!("2")] {
        assert!(aditor::ipc::jobs(&value).is_err());
    }
    assert_eq!(aditor::ipc::jobs(&json!(2)).unwrap(), Some(2));
    assert!(aditor::ipc::jobs(&Value::Null).unwrap().is_none());
    for value in [json!(4), json!("bad"), json!("")] {
        assert!(aditor::ipc::explicit_layout(&value).is_err());
    }
    assert!(aditor::ipc::explicit_layout(&json!("4:3"))
        .unwrap()
        .is_some());
}

#[test]
fn corrupt_cached_scale_returns_error_and_releases_busy_state() {
    let mut s = Server::new();
    let tmp = common::TempDir::new();
    let a = args(&tmp);
    let path = a["path"].as_str().unwrap();
    let reference: Value = serde_json::from_str(include_str!("parity/analyze.json")).unwrap();
    let mut doc = reference["documents"][0]["expected"].clone();
    doc["video"] = json!(aditor::probe::probe(path).unwrap());
    doc["analysis"]["status"] = "partial".into();
    doc["analysis"]["h_scale"] = json!(1e100);
    doc["analysis"]["progress_t"] = json!(0.);
    doc["analysis"]["keywords"] = json!({});
    let cp = aditor::cache::cache_path(path, &tmp.0, false);
    aditor::cache::save_cache(&cp, &doc, None).unwrap();
    for id in ["corrupt-one", "corrupt-two"] {
        s.send(id, "analyze", a.clone());
        assert_eq!(s.terminal(id)["code"], "internal");
    }
    s.send("probe", "probe", a);
    assert_eq!(s.next()["type"], "result");
}

#[test]
fn invalid_utf8_is_a_request_error_and_does_not_end_the_session() {
    let mut s = Server::new();
    s.input
        .as_mut()
        .unwrap()
        .write_all(b"{\"id\":\"\xff\"}\n")
        .unwrap();
    s.input.as_mut().unwrap().flush().unwrap();
    let error = s.next();
    assert!(error["id"].is_null());
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "bad_request");
    let tmp = common::TempDir::new();
    s.send("good", "probe", args(&tmp));
    assert_eq!(s.next()["type"], "result");
}
