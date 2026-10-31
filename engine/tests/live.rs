mod common;
#[path = "common/phase_c.rs"]
mod parity;
#[path = "common/shm_writer.rs"]
mod writer;
use aditor::{layout::Layout, live::*};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn name() -> String {
    format!(
        "Local\\aditor-phase-c-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
fn layout() -> ShmLayout {
    let p = common::profile();
    ShmLayout {
        banner: (p.banner_roi[2] as usize, p.banner_roi[3] as usize),
        spec: (p.spec_roi[2] as usize, p.spec_roi[3] as usize),
        thumb: (640, 360),
        killfeed: (0, 0),
    }
}
fn make_writer(name: &str, l: ShmLayout) -> writer::ShmWriter {
    writer::ShmWriter::create(
        name,
        writer::ShmLayout {
            banner: (l.banner.0 as u32, l.banner.1 as u32),
            spec: (l.spec.0 as u32, l.spec.1 as u32),
            thumb: (l.thumb.0 as u32, l.thumb.1 as u32),
            killfeed: (l.killfeed.0 as u32, l.killfeed.1 as u32),
        },
    )
    .unwrap()
}
fn blank(l: ShmLayout) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        vec![0; l.banner_bytes()],
        vec![0; l.spec_bytes()],
        vec![0; l.thumb_bytes()],
    )
}
#[test]
fn header_validation_legacy_and_optional_feed() {
    let l = ShmLayout {
        banner: (7, 3),
        spec: (5, 2),
        thumb: (4, 2),
        killfeed: (0, 0),
    };
    assert_eq!(l.slot_size(), 136);
    let mut header = [0u8; 64];
    header[..8].copy_from_slice(b"APXSHM01");
    for (off, v) in [
        (8, 1),
        (12, 16),
        (16, 136),
        (20, 7),
        (24, 3),
        (28, 5),
        (32, 2),
        (36, 4),
        (40, 2),
    ] {
        header[off..off + 4].copy_from_slice(&(v as u32).to_le_bytes());
    }
    assert_eq!(parse_header(&header, l.total_size()).unwrap(), l);
    for (off, v) in [
        (0, 0),
        (8, 9),
        (12, 15),
        (16, 128),
        (20, 0),
        (36, 4096),
        (40, 4096),
    ] {
        let mut h = header;
        h[off..off + 4].copy_from_slice(&(v as u32).to_le_bytes());
        assert!(parse_header(&h, l.total_size())
            .unwrap_err()
            .is::<LayoutError>());
    }
    let large = ShmLayout {
        thumb: (4096, 360),
        ..l
    };
    let mut oversized = header;
    for (off, v) in [(16, large.slot_size()), (36, 4096), (40, 360)] {
        oversized[off..off + 4].copy_from_slice(&(v as u32).to_le_bytes());
    }
    assert_eq!(
        parse_header(&oversized, large.total_size())
            .unwrap_err()
            .to_string(),
        "Thumbnail dimensions exceed 1920×1080"
    );
    assert!(parse_header(&header, 63).is_err());
    assert!(parse_header(&header, l.total_size() - 1).is_err());
    let l = ShmLayout {
        killfeed: (3, 2),
        ..l
    };
    let n = name();
    let mut w = make_writer(&n, l);
    let r = ShmReader::open(&n).unwrap();
    let (b, s, _) = blank(l);
    w.write(42, &b, &s, None, Some(&[123; 18])).unwrap();
    let slot = r.read(1).unwrap();
    assert_eq!(slot.pts, 42);
    assert!(slot.thumb.is_none());
    assert_eq!(slot.killfeed.unwrap().data, vec![123; 18]);
    assert!(ShmReader::open(&name()).is_err());
}
#[test]
fn ring_overwrite_copies_and_writer_exit() {
    let l = layout();
    let n = name();
    let mut w = make_writer(&n, l);
    let r = ShmReader::open(&n).unwrap();
    assert_eq!(r.latest(), 0);
    let (mut b, s, th) = blank(l);
    for seq in 1..=20 {
        b.fill(seq);
        w.write(seq as i64, &b, &s, Some(&th), None).unwrap();
    }
    assert!(r.read(1).is_none());
    let slot = r.read(20).unwrap();
    assert_eq!(slot.banner.data[0], 20);
    w.write(21, &vec![21; b.len()], &s, None, None).unwrap();
    assert_eq!(slot.banner.data[0], 20);
    drop(w);
    assert_eq!(r.latest(), 21);
    assert_eq!(r.peek_pts(21), Some(21));
}
#[test]
fn backlog_lag_quality_grid_and_final_contract() {
    let l = layout();
    let n = name();
    let mut w = make_writer(&n, l);
    let r = ShmReader::open(&n).unwrap();
    let (b, s, t) = blank(l);
    for k in 0..20 {
        w.write(
            k * 2_500_000,
            &b,
            &s,
            if k % 4 == 0 { Some(&t) } else { None },
            None,
        )
        .unwrap();
    }
    let p = LiveProfile::Apex(Box::new(common::profile()));
    let mut e = LiveEngine::new(r, p, None).unwrap();
    assert_eq!(e.poll().unwrap().0, 8);
    assert_eq!(e.skipped, 12);
    assert_eq!(e.last_t, Some(4.75));
    assert_eq!(
        e.quality()["reasons"],
        json!(["startup_frames_lost", "frames_lost"])
    );
    for k in 20..40 {
        w.write(k * 2_500_000, &b, &s, None, None).unwrap();
    }
    assert_eq!(e.poll().unwrap().0, 1);
    assert_eq!(e.skipped, 31);
    assert_eq!(e.grid_time(9_750_000), None);
    assert!(e.grid_time(100_000_000).is_some());
    let out = e.finish().unwrap();
    assert_eq!(out.last().unwrap()["final"], true);
    assert_eq!(out.last().unwrap()["quality"]["complete"], false);
}
fn command(n: &str, game: &str) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_aditor"));
    let dir = if game == "valorant" {
        "../templates/valorant/icons"
    } else {
        "../templates/icons"
    };
    cmd.args(["live", "--shm", n, "--profile-dir"])
        .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(dir))
        .args(["--game", game]);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}
fn session(mut cmd: Command, stop: bool) -> Vec<Value> {
    let mut child = cmd.spawn().unwrap();
    let out = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        for line in BufReader::new(out).lines() {
            tx.send(serde_json::from_str::<Value>(&line.unwrap()).unwrap())
                .unwrap();
        }
    });
    let first = rx.recv_timeout(Duration::from_secs(60)).unwrap();
    assert_eq!(first["ev"], "ready", "{first}");
    if stop {
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"{bad\n{}\n{\"cmd\":\"stop\"}\n")
            .unwrap();
    }
    drop(child.stdin.take());
    let mut lines = vec![first];
    while let Ok(v) = rx.recv_timeout(Duration::from_secs(60)) {
        lines.push(v);
    }
    let status = child.wait().unwrap();
    let err = std::io::read_to_string(child.stderr.take().unwrap()).unwrap();
    assert!(status.success(), "{err}");
    worker.join().unwrap();
    assert_eq!(lines.last().unwrap()["ev"], "snapshot");
    lines
}
#[test]
fn live_cli_frozen_json_lines_parity_after_writer_disappears() {
    for game in ["apex", "valorant"] {
        for stop in [false, true] {
            let l = if game == "apex" {
                layout()
            } else {
                let p = aditor::valorant::load_valorant_profile(
                    &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../templates/valorant/icons"),
                )
                .unwrap();
                ShmLayout {
                    banner: (p.capture_banner[2] as usize, p.capture_banner[3] as usize),
                    spec: (p.capture_spec[2] as usize, p.capture_spec[3] as usize),
                    thumb: (640, 360),
                    killfeed: (0, 0),
                }
            };
            let n = name();
            let mut w = make_writer(&n, l);
            let (mut b, mut s, th) = blank(l);
            if game == "apex" {
                let c = &parity::cases()["live_kills"][1]["calls"][0];
                b = parity::image(c["banner"].as_str().unwrap()).data;
                s = parity::image(c["spec"].as_str().unwrap()).data;
            } else {
                let p = aditor::valorant::load_valorant_profile(
                    &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../templates/valorant/icons"),
                )
                .unwrap();
                let c = &parity::cases()["valorant_video"];
                for (buf, im, cap, x) in [
                    (
                        &mut b,
                        parity::image(c["feeds"][0].as_str().unwrap()),
                        p.capture_banner,
                        1316,
                    ),
                    (
                        &mut s,
                        parity::image(c["board"].as_str().unwrap()),
                        p.capture_spec,
                        740,
                    ),
                ] {
                    for y in 0..im.height {
                        let start = (y * cap[2] as usize + (x - cap[0]) as usize) * 3;
                        buf[start..start + im.width * 3]
                            .copy_from_slice(&im.data[y * im.width * 3..(y + 1) * im.width * 3]);
                    }
                }
            }

            for k in 0..8 {
                w.write(
                    k * 2_500_000,
                    &b,
                    &s,
                    if k % 4 == 0 { Some(&th) } else { None },
                    None,
                )
                .unwrap();
            }
            let rust_reader = ShmReader::open(&n).unwrap();
            let py: Vec<Value> = serde_json::from_slice(
                &std::fs::read(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join(format!("tests/parity/phase_c/live_{game}_{stop}.json")),
                )
                .unwrap(),
            )
            .unwrap();
            drop(w);
            let rust = session(command(&n, game), stop);
            assert!(rust
                .iter()
                .filter(|v| v["ev"] == "stats")
                .all(|v| v["snapshot_cpu_ms"].as_f64().is_some_and(|ms| ms >= 0.)));
            drop(rust_reader);
            let scrub = |mut lines: Vec<Value>| {
                for v in &mut lines {
                    if v["ev"] == "stats" {
                        v.as_object_mut().unwrap().remove("cpu_ms_per_frame");
                        if let Some(ms) = v.get("snapshot_cpu_ms") {
                            assert!(ms.as_f64().is_some_and(|v| v >= 0.));
                        }
                        v.as_object_mut().unwrap().remove("snapshot_cpu_ms");
                    }
                }
                lines
            };
            // CPU timing fields measure runtime cost rather than frame content.
            parity::close(&json!(scrub(rust)), &json!(scrub(py)));
        }
    }
}
#[test]
fn layouts_allow_reference_only_at_identity() {
    let p = common::profile();
    check_layout(layout(), &LiveProfile::Apex(Box::new(p.clone())), true).unwrap();
    assert!(check_layout(
        layout(),
        &LiveProfile::Apex(Box::new(p.with_layout(Layout { squash: 0.75 }))),
        true
    )
    .is_err());
    let mut l = layout();
    l.thumb = (320, 180);
    assert!(check_layout(l, &LiveProfile::Apex(Box::new(p)), true).is_err());
}
#[test]
fn live_buffer_caps_report_degradation() {
    let p = common::profile();
    let call = &parity::cases()["live_kills"][1]["calls"][0];
    let b = parity::image(call["banner"].as_str().unwrap());
    let s = parity::image(call["spec"].as_str().unwrap());
    let mut k = LiveKills::new(
        &p,
        KillLimits {
            calib_bytes: 0,
            ..Default::default()
        },
    )
    .unwrap();
    k.feed(0., &b, &s, None, None).unwrap();
    assert_eq!(k.degraded, vec!["calib_buffer_cap"]);
    assert!(k.finish().is_ok());
}
#[test]
#[ignore = "slow: requires ADITOR_GOLDEN_VIDEO and complete offline/live decoding"]
fn golden_live_matches_offline() {
    let video = std::env::var("ADITOR_GOLDEN_VIDEO").expect("ADITOR_GOLDEN_VIDEO");
    let p = common::profile();
    let temp = common::TempDir::new();
    let offline = aditor::analyze::analyze(
        &video,
        &p,
        aditor::analyze::AnalyzeOptions {
            game: Some("apex"),
            jobs: Some(1),
            layout: Some(Layout::default()),
            ..aditor::analyze::AnalyzeOptions::new(&temp.0)
        },
    )
    .unwrap();
    let mut kills = LiveKills::new(&p, Default::default()).unwrap();
    let mut stream = aditor::decode::FrameStream::new(&video, p, Default::default());
    while let Some(f) = stream.next() {
        let (t, b, s) = f.unwrap();
        kills
            .feed(t, &b, &s, stream.killfeed.as_ref(), stream.thumb.as_ref())
            .unwrap();
    }
    let (e, _) = kills.finish().unwrap();
    let counted: Vec<_> = e.iter().filter(|e| e.counted && !e.deleted).collect();
    let expected: Vec<_> = offline["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["counted"] == true && e["deleted"] != true)
        .collect();
    let mut left = counted;
    let mut hits = 0;
    for v in &expected {
        if let Some(i) = left
            .iter()
            .position(|e| v["type"] == e.kind && (v["t"].as_f64().unwrap() - e.t).abs() <= 0.5)
        {
            left.remove(i);
            hits += 1;
        }
    }
    assert!(hits as f64 >= expected.len() as f64 * 0.95);
    assert!(left.is_empty());
}
#[test]
#[ignore = "slow: requires ADITOR_MATCH_DIR recordings"]
fn recordings_live_match_boundaries_match_offline() {
    let dir = std::env::var("ADITOR_MATCH_DIR").expect("ADITOR_MATCH_DIR");
    let truth: Value = serde_json::from_str(include_str!("fixtures/matches/truth.json")).unwrap();
    for filename in truth.as_object().unwrap().keys() {
        let path = std::path::Path::new(&dir).join(filename);
        let path = path.to_str().unwrap();
        let expected =
            aditor::matches::analyze_matches(path, 1., false, true, Some(Layout::default()), None)
                .unwrap();
        let l = layout();
        let n = name();
        let mut w = make_writer(&n, l);
        let r = ShmReader::open(&n).unwrap();
        let mut e = LiveEngine::new(
            r,
            LiveProfile::Apex(Box::new(common::profile())),
            Some(aditor::scene::SceneMatcher::new(None).unwrap()),
        )
        .unwrap();
        let (b, s, _) = blank(l);
        let mut output = vec![];
        for f in aditor::matches::VideoFrames::new(path, 1., true, "h264") {
            let (t, thumb) = f.unwrap();
            w.write(
                (t * 10_000_000.).round_ties_even() as i64,
                &b,
                &s,
                Some(&thumb.data),
                None,
            )
            .unwrap();
            output.extend(e.poll().unwrap().1);
        }
        output.extend(e.finish().unwrap());
        let starts: Vec<_> = output
            .iter()
            .filter(|v| v["ev"] == "match_start")
            .map(|v| v["t"].as_f64().unwrap())
            .collect();
        let ends: Vec<_> = output
            .iter()
            .filter(|v| v["ev"] == "match_end")
            .map(|v| v["t"].as_f64().unwrap())
            .collect();
        let wanted = expected["matches"].as_array().unwrap();
        assert_eq!(starts.len(), wanted.len());
        assert_eq!(ends.len(), wanted.len());
        for ((start, end), w) in starts.iter().zip(ends).zip(wanted) {
            assert!((start - w["start"].as_f64().unwrap()).abs() <= 2.);
            assert!((end - w["end"].as_f64().unwrap()).abs() <= 2.);
        }
    }
}
#[test]
fn torn_slots_are_counted_and_following_slots_are_processed() {
    let l = layout();
    let n = name();
    let mut w = make_writer(&n, l);
    let r = ShmReader::open(&n).unwrap();
    let (b, s, _) = blank(l);
    w.write(0, &b, &s, None, None).unwrap();
    w.tear_end(1);
    assert!(r.read(1).is_none());
    assert!(r.peek_pts(1).is_none());
    w.write(2_500_000, &b, &s, None, None).unwrap();
    let mut e = LiveEngine::new(r, LiveProfile::Apex(Box::new(common::profile())), None).unwrap();
    assert_eq!(e.poll().unwrap().0, 1);
    assert_eq!(e.torn, 1);
    assert_eq!(e.frames, 1);
}
#[test]
fn empty_session_and_cli_error_envelopes() {
    let n = name();
    let w = make_writer(&n, layout());
    let lines = session(command(&n, "apex"), false);
    assert_eq!(
        lines
            .iter()
            .map(|v| v["ev"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["ready", "stats", "snapshot"]
    );
    assert_eq!(lines[2]["quality"]["frames"], 0);
    drop(w);
    let out = command(&name(), "apex").output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["code"], "shm_open_failed");
    assert_eq!(doc["exception"]["type"], "FileNotFoundError");
    let n = name();
    let w = make_writer(
        &n,
        ShmLayout {
            banner: (7, 3),
            spec: (5, 2),
            thumb: (640, 360),
            killfeed: (0, 0),
        },
    );
    let out = command(&n, "apex").output().unwrap();
    drop(w);
    assert_eq!(out.status.code(), Some(1));
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["code"], "bad_layout");
}

#[test]
fn scene_events_forward_pending_cancel_and_sustained_hud_resume() {
    let l = layout();
    let scene = || aditor::scene::SceneMatcher::new(None).unwrap();
    let pre = parity::cases()["scene"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["full"]["kind"] == "pre_match")
        .unwrap();
    let pre = parity::screen(pre["file"].as_str().unwrap());
    let lobby = parity::screen("clip1_0000.png");
    let hud = parity::screen("clip1_0120.png");
    let (b, s, black) = blank(l);
    for (end, thumb, reason) in [
        (1., &lobby.data, "lobby"),
        (181., &black, "timeout"),
        (1., &pre.data, "eof"),
    ] {
        let n = name();
        let mut w = make_writer(&n, l);
        let mut e = LiveEngine::new(
            ShmReader::open(&n).unwrap(),
            LiveProfile::Apex(Box::new(common::profile())),
            Some(scene()),
        )
        .unwrap();
        let mut output = vec![];
        for (t, th) in [(0., &pre.data), (end, thumb)] {
            w.write((t * 10_000_000.) as i64, &b, &s, Some(th), None)
                .unwrap();
            output.extend(e.poll().unwrap().1);
        }
        output.extend(e.finish().unwrap());
        let matches: Vec<_> = output
            .into_iter()
            .filter(|v| v["ev"].as_str().unwrap().starts_with("match_"))
            .collect();
        assert_eq!(
            matches,
            vec![
                json!({"ev":"match_pending","t":0.,"reason":"pre_match"}),
                json!({"ev":"match_cancel","t":end,"reason":reason})
            ]
        );
    }
    let n = name();
    let mut w = make_writer(&n, l);
    let mut e = LiveEngine::new(
        ShmReader::open(&n).unwrap(),
        LiveProfile::Apex(Box::new(common::profile())),
        Some(scene()),
    )
    .unwrap();
    let mut output = vec![];
    for i in 0..36 {
        let thumb = if i == 0 {
            &lobby.data
        } else if i < 16 {
            &black
        } else {
            &hud.data
        };
        w.write(
            i * 2_500_000,
            &b,
            &s,
            if i % 4 == 0 { Some(thumb) } else { None },
            None,
        )
        .unwrap();
        output.extend(e.poll().unwrap().1);
    }
    output.extend(e.finish().unwrap());
    let matches: Vec<_> = output
        .into_iter()
        .filter(|v| v["ev"] == "match_start" || v["ev"] == "match_end")
        .collect();
    assert_eq!(
        matches,
        vec![
            json!({"ev":"match_start","t":4.,"reason":"hud_resume"}),
            json!({"ev":"match_end","t":8.75,"reason":"eof"})
        ]
    );
}

#[test]
fn synthetic_and_stretched_capture_live_match_offline() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for squash in [1., 0.75] {
        let p = common::profile().with_layout(Layout { squash });
        let temp = common::TempDir::new();
        let path = if squash == 1. {
            root.join("tests/parity/media/knocks.mp4")
        } else {
            common::make_video(
                &temp.0,
                "stretched.mp4",
                12.,
                common::VideoOptions {
                    game_height: Some(1440),
                    overlay: Some((
                        &root.join("tests/fixtures/en/pos/knock_a002500.png"),
                        &[(2., 5.), (8., 10.)],
                    )),
                    ..Default::default()
                },
            )
        };
        let path = path.to_str().unwrap();
        let offline = aditor::analyze::analyze(
            path,
            &p,
            aditor::analyze::AnalyzeOptions {
                game: Some("apex"),
                jobs: Some(1),
                hwaccel: false,
                layout: Some(p.layout),
                ..aditor::analyze::AnalyzeOptions::new(&temp.0)
            },
        )
        .unwrap();
        let (bc, sc) = (p.capture_banner(), p.capture_spec());
        let l = ShmLayout {
            banner: (bc[2] as usize, bc[3] as usize),
            spec: (sc[2] as usize, sc[3] as usize),
            ..layout()
        };
        check_layout(l, &LiveProfile::Apex(Box::new(p.clone())), true).unwrap();
        let n = name();
        let mut w = make_writer(&n, l);
        let mut e = LiveEngine::new(
            ShmReader::open(&n).unwrap(),
            LiveProfile::Apex(Box::new(p.clone())),
            None,
        )
        .unwrap();
        let mut raw = p;
        raw.banner_roi = bc;
        raw.spec_roi = sc;
        raw.layout = Layout::default();
        let stream = aditor::decode::FrameStream::new(
            path,
            raw,
            aditor::decode::DecodeOptions {
                hwaccel: false,
                ..Default::default()
            },
        );
        for f in stream {
            let (t, b, s) = f.unwrap();
            w.write(
                (t * 10_000_000.).round_ties_even() as i64,
                &b.data,
                &s.data,
                None,
                None,
            )
            .unwrap();
            e.poll().unwrap();
        }
        let out = e.finish().unwrap();
        let final_doc = out.last().unwrap();
        parity::close(&final_doc["events"], &offline["events"]);
        assert_eq!(final_doc["spectating"], offline["spectating"]);
        assert_eq!(final_doc["quality"]["aspect_squash"], squash);
        assert_eq!(
            final_doc["quality"]["h_scale"],
            offline["analysis"]["h_scale"]
        );
        assert_eq!(final_doc["quality"]["complete"], true);
        assert!(offline["events"].as_array().unwrap().len() >= 2);
    }
}

#[test]
fn untrusted_sequence_and_pts_extremes_do_not_overflow() {
    let l = layout();
    let n = name();
    let mut w = make_writer(&n, l);
    let r = ShmReader::open(&n).unwrap();
    let mut e = LiveEngine::new(r, LiveProfile::Apex(Box::new(common::profile())), None).unwrap();
    let (b, s, _) = blank(l);
    w.write(i64::MAX, &b, &s, None, None).unwrap();
    e.last_pts = Some(i64::MIN);
    assert_eq!(e.lag_seconds(), (u64::MAX as f64) / 10_000_000.);
    e.skipped = u64::MAX;
    e.torn = 1;
    e.frames = 1;
    assert_eq!(e.quality()["complete"], false);
    w.set_sequence(u64::MAX - 1);
    w.write(0, &b, &s, None, None).unwrap();
    e.next_seq = Some(u64::MAX);
    assert_eq!(
        e.poll().unwrap_err().to_string(),
        "Shared-memory sequence number exhausted"
    );
}
