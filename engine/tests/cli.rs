use aditor::cli::parse;
mod common;
fn args(s: &[&str]) -> Vec<String> {
    s.iter().map(|s| s.to_string()).collect()
}
#[test]
fn subcommands_flags_and_required_options() {
    for a in [
        vec!["ipc"],
        vec![
            "analyze",
            "x.mp4",
            "--profile-dir",
            "icons",
            "--cache-dir",
            "cache",
            "--jobs=2",
            "--force",
        ],
        vec!["matches", "x.mp4", "--fps", "0.5", "--timeline"],
        vec![
            "live",
            "--shm",
            "Local\\x",
            "--profile-dir",
            "icons",
            "--game",
            "valorant",
        ],
    ] {
        assert!(parse(args(&a)).unwrap().is_some());
    }
    for a in [
        vec![],
        vec!["bad"],
        vec!["analyze", "x.mp4"],
        vec!["live", "--shm", "x"],
        vec!["ipc", "--bogus"],
        vec!["matches", "x", "--fps", "bad"],
    ] {
        assert!(parse(args(&a)).is_err());
    }
    assert!(parse(args(&["--help"])).unwrap().is_none());
}
#[test]
fn matches_failures_have_no_partial_json_and_live_errors_are_json_lines() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_aditor"))
        .args(["matches", "absent.mp4"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).starts_with("Error: "));
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_aditor"))
        .args(["live", "--shm", "absent", "--profile-dir", "absent"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let doc: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(doc["ev"], "error");
    assert_eq!(doc["code"], "internal");
    assert!(output.stderr.is_empty());
}

#[test]
fn analyze_help_and_errors_match_python_text() {
    let binary = env!("CARGO_BIN_EXE_aditor");
    let help = std::process::Command::new(binary)
        .args(["analyze", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(help.stderr.is_empty());
    assert_eq!(
        String::from_utf8(help.stdout).unwrap(),
        format!(
            "{}\n{}\n",
            aditor::cli::ANALYZE_USAGE,
            aditor::cli::ANALYZE_HELP
        )
    );
    let error = std::process::Command::new(binary)
        .args([
            "analyze",
            "x",
            "--profile-dir",
            "x",
            "--cache-dir",
            "x",
            "--jobs",
            "foo",
        ])
        .output()
        .unwrap();
    assert_eq!(error.status.code(), Some(2));
    assert!(error.stdout.is_empty());
    assert_eq!(
        String::from_utf8(error.stderr).unwrap(),
        format!(
            "{}\naditor analyze: error: argument --jobs: invalid int value: 'foo'\n",
            aditor::cli::ANALYZE_USAGE
        )
    );
}
#[test]
fn analyze_cache_hit_summary_and_out_document() {
    let temp = common::TempDir::new();
    let p = common::profile();
    let video =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/media/knocks.mp4");
    let path = video.to_str().unwrap();
    let reference: serde_json::Value =
        serde_json::from_str(include_str!("parity/analyze.json")).unwrap();
    let mut doc = reference["documents"][0]["expected"].clone();
    doc["video"] = serde_json::to_value(aditor::probe::probe(path).unwrap()).unwrap();
    let cp = aditor::cache::cache_path(path, &temp.0, false);
    doc["cache_path"] = cp.to_str().unwrap().into();
    aditor::cache::save_cache(&cp, &doc, None).unwrap();
    let out = temp.0.join("out.json");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_aditor"))
        .arg("analyze")
        .arg(&video)
        .arg("--profile-dir")
        .arg(&p.dir)
        .arg("--cache-dir")
        .arg(&temp.0)
        .args([
            "--no-hwaccel",
            "--game",
            "apex",
            "--aspect",
            "16:9",
            "--out",
        ])
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("2 events (2 counted), cache: {}\n", cp.display())
    );
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "\n");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(out).unwrap()).unwrap(),
        doc
    );
    doc["events"] = serde_json::json!({});
    aditor::cache::save_cache(&cp, &doc, None).unwrap();
    let failed = std::process::Command::new(env!("CARGO_BIN_EXE_aditor"))
        .arg("analyze")
        .arg(&video)
        .arg("--profile-dir")
        .arg(&p.dir)
        .arg("--cache-dir")
        .arg(&temp.0)
        .args(["--game", "apex", "--aspect", "16:9"])
        .output()
        .unwrap();
    assert_eq!(failed.status.code(), Some(1));
    assert!(failed.stdout.is_empty());
    assert_eq!(
        String::from_utf8(failed.stderr).unwrap(),
        "\nError: Invalid cache events: expected an array\n"
    );
}
#[test]
fn matches_and_live_help_are_complete() {
    for (name, expected) in [
        ("matches", aditor::cli::MATCHES_HELP),
        ("live", aditor::cli::LIVE_HELP),
    ] {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_aditor"))
            .args([name, "--help"])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(out.stderr.is_empty());
        assert_eq!(String::from_utf8(out.stdout).unwrap(), expected);
    }
}
