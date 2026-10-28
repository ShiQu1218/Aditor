mod common;
use aditor::{
    analyze::{analyze, AnalyzeOptions},
    autoclip, derive,
    layout::Layout,
    models::{Event, SpecInterval},
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
};

fn cases() -> Value {
    serde_json::from_str(include_str!("parity/analyze.json")).unwrap()
}
fn portable(mut doc: Value) -> Value {
    // Ignore only cache_path, video.path and video.mtime: machine paths and filesystem timestamps.
    doc.as_object_mut().unwrap().remove("cache_path");
    if let Some(v) = doc.get_mut("video") {
        for k in ["path", "mtime"] {
            v.as_object_mut().unwrap().remove(k);
        }
    }
    doc
}
fn assert_document(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        // Scores come directly from matchTemplate, whose binding numerical contract is 1e-4.
        (Value::Number(a), Value::Number(b)) if path.ends_with(".score") => assert!(
            (a.as_f64().unwrap() - b.as_f64().unwrap()).abs() <= 1e-4,
            "{path}: {a} != {b}"
        ),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_document(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (key, a) in a {
                assert_document(a, &b[key], &format!("{path}.{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn analyze_documents_derive_and_autoclip() {
    let p = common::profile();
    let temp = common::TempDir::new();
    for c in cases()["documents"].as_array().unwrap() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(c["file"].as_str().unwrap());
        let doc = analyze(
            path.to_str().unwrap(),
            &p,
            AnalyzeOptions {
                force: true,
                hwaccel: false,
                jobs: Some(c["jobs"].as_u64().unwrap() as usize),
                game: Some("apex"),
                layout: Some(Layout::default()),
                ..AnalyzeOptions::new(&temp.0)
            },
        )
        .unwrap();
        assert_document(
            &portable(doc.clone()),
            &c["expected"],
            &format!("{} jobs={}", path.display(), c["jobs"]),
        );
        let events: Vec<Event> = serde_json::from_value(doc["events"].clone()).unwrap();
        let spec: Vec<SpecInterval> = serde_json::from_value(doc["spectating"].clone()).unwrap();
        assert_document(
            &json!(derive::derive(&events, &spec, &p)),
            &c["derived"],
            "derived",
        );
        let params = serde_json::from_value(c["params"].clone()).unwrap();
        assert_eq!(
            json!(autoclip::auto_clips(
                &events,
                &params,
                doc["video"]["duration"].as_f64().unwrap()
            )),
            c["clips"]
        );
    }
}

#[test]
fn ipc_reference_request_script() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_aditor"))
        .arg("ipc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let mut responses = vec![serde_json::from_str::<Value>(&line).unwrap()];
    let c = cases();
    let tmp = common::TempDir::new();
    for mut request in c["ipc"]["requests"].as_array().unwrap().clone() {
        if request["args"]["profile_dir"] == "@profile" {
            request["args"]["profile_dir"] = common::profile().dir.to_str().unwrap().into();
        }
        if request["args"]["path"] == "@video" {
            request["args"]["path"] = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/parity/media/knocks.mp4")
                .to_str()
                .unwrap()
                .into();
        }
        if request["args"]["cache_dir"] == "@cache" {
            request["args"]["cache_dir"] = tmp.0.to_str().unwrap().into();
        }
        writeln!(input, "{request}").unwrap();
        input.flush().unwrap();
        let mut last_progress = None;
        loop {
            line.clear();
            output.read_line(&mut line).unwrap();
            let mut response: Value = serde_json::from_str(&line).unwrap();
            // Progress frequency is wall-clock dependent; every sample and final completion are still checked.
            if response["type"] == "progress" {
                assert!(response["t"].as_f64().unwrap() <= response["duration"].as_f64().unwrap());
                last_progress = Some(response);
                continue;
            }
            if response["id"] == "analyze" {
                assert_eq!(last_progress.unwrap()["t"], 12.);
                response["data"] = portable(response["data"].take());
            }
            if response["id"] == "probe" {
                for key in ["path", "mtime"] {
                    response["data"].as_object_mut().unwrap().remove(key);
                }
            }
            responses.push(response);
            break;
        }
    }
    drop(input);
    assert!(child.wait().unwrap().success());
    let sort = |a: &mut Vec<Value>| a.sort_by_key(|v| v["id"].as_str().unwrap_or("").to_owned());
    let mut expected = c["ipc"]["responses"].as_array().unwrap().clone();
    sort(&mut responses);
    sort(&mut expected);
    assert_document(&json!(responses), &json!(expected), "ipc");
}
