mod common;
use aditor::{
    autoclip, derive,
    detect::{self, Detector},
    events::EventTracker,
    mixtape::MixtapeDetector,
    models::{FrameResult, NameSig},
};
use serde_json::{json, Value};
use std::path::Path;

fn cases() -> Value {
    serde_json::from_str(include_str!("parity/phase_b.json")).unwrap()
}
fn revive_aware_expected(mut events: Value) -> Value {
    // Revives make separate knocks count; retain the frozen Python oracle on disk.
    for e in events.as_array_mut().unwrap() {
        if matches!(e["type"].as_str(), Some("knock" | "assist_knock"))
            && e["counted_reason"] == "duplicate"
        {
            e["counted"] = json!(true);
            e["counted_reason"] = json!("first");
        }
    }
    events
}
fn frame(v: &Value) -> FrameResult {
    FrameResult {
        kind: v["kind"].as_str().map(str::to_owned),
        score: v["score"].as_f64().unwrap(),
        x: v["x"].as_i64().unwrap() as i32,
        damage_line: v["damage_line"].as_bool().unwrap(),
        name_sig: v["name_sig"]
            .as_str()
            .map(|s| NameSig::from_b64(s).unwrap()),
        spectating: v["spectating"].as_bool().unwrap(),
        hint: v["hint"].as_str().map(str::to_owned),
    }
}
fn frame_json(r: FrameResult) -> Value {
    json!({"kind":r.kind,"score":r.score,"x":r.x,"damage_line":r.damage_line,"name_sig":r.name_sig.map(|s|s.to_b64()),"spectating":r.spectating,"hint":r.hint})
}
fn close(a: &Value, b: &Value, context: &str) {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => assert!(
            (a.as_f64().unwrap() - b.as_f64().unwrap()).abs() <= 1e-4,
            "{context}: {a} != {b}"
        ),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{context}");
            for (a, b) in a.iter().zip(b) {
                close(a, b, context);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{context}");
            for (k, a) in a {
                close(a, &b[k], &format!("{context}.{k}"));
            }
        }
        _ => assert_eq!(a, b, "{context}"),
    }
}
#[test]
fn event_tracker_reference_traces() {
    let p = common::profile();
    for c in cases()["events"].as_array().unwrap() {
        let mut tracker = EventTracker::new(&p, c["resume_start"].as_f64());
        for (i, f) in c["frames"].as_array().unwrap().iter().enumerate() {
            tracker.feed(f[0].as_f64().unwrap(), frame(&f[1]));
            for snap in c["snapshots"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|s| s[0] == i + 1)
            {
                let (ev, spec) = tracker.snapshot();
                assert_eq!(json!([ev, spec]), snap[1], "{} frame {i}", c["test"]);
            }
        }
        let (ev, spec) = tracker.finish();
        assert_eq!(json!([ev, spec]), c["expected"], "{}", c["test"]);
    }
}
#[test]
fn derive_and_autoclip_reference_cases() {
    let p = common::profile();
    let cases = cases();
    for c in cases["derive"].as_array().unwrap() {
        let events: Vec<aditor::models::Event> =
            serde_json::from_value(c["events"].clone()).unwrap();
        let spec: Vec<aditor::models::SpecInterval> =
            serde_json::from_value(c["spectating"].clone()).unwrap();
        assert_eq!(
            json!(derive::derive(&events, &spec, &p)),
            revive_aware_expected(c["expected"].clone()),
            "{}",
            c["test"]
        );
    }
    for c in cases["autoclip"].as_array().unwrap() {
        let events: Vec<aditor::models::Event> =
            serde_json::from_value(c["events"].clone()).unwrap();
        let params = serde_json::from_value(c["params"].clone()).unwrap();
        assert_eq!(
            json!(autoclip::auto_clips(
                &events,
                &params,
                c["duration"].as_f64().unwrap()
            )),
            c["expected"],
            "{}",
            c["test"]
        );
    }
}

#[test]
fn cache_merge_and_serialized_bytes_reference_cases() {
    let cases = cases();
    for c in cases["merge"].as_array().unwrap() {
        let old = serde_json::from_value::<Vec<aditor::models::Event>>(c["old"].clone()).unwrap();
        let new = serde_json::from_value::<Vec<aditor::models::Event>>(c["new"].clone()).unwrap();
        let (events, unmatched) = aditor::cache::merge_reanalysis(&old, &new);
        assert_eq!(json!([events, unmatched]), c["expected"]);
    }
    for c in cases["clips_merge"].as_array().unwrap() {
        let old = serde_json::from_value::<Vec<aditor::models::Clip>>(c["old"].clone()).unwrap();
        let new = serde_json::from_value::<Vec<aditor::models::Clip>>(c["new"].clone()).unwrap();
        assert_eq!(
            aditor::cache::merge_clips(&old, &new),
            serde_json::from_value::<Vec<aditor::models::Clip>>(c["expected"].clone()).unwrap()
        );
    }
    for c in cases["cache_bytes"].as_array().unwrap() {
        assert_eq!(
            String::from_utf8(aditor::cache::json_bytes(&c["value"]).unwrap()).unwrap(),
            c["expected"].as_str().unwrap()
        );
    }
}
fn detection_reference_crops(prefix: &str) {
    let p = common::profile();
    let det = Detector::new(&p, 1., None, None).unwrap();
    let mix = MixtapeDetector::new(&p).unwrap();
    let refs = cases();
    let learned = refs["keywords"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["lang"] == prefix)
        .map(|c| {
            Detector::new(
                &p,
                1.,
                None,
                Some(detect::Keywords::from_dict(Some(&c["expected"])).unwrap()),
            )
            .unwrap()
        });
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for c in refs["detection"].as_array().unwrap() {
        let file = c["file"].as_str().unwrap();
        if !file.starts_with(&format!("{prefix}/")) {
            continue;
        }
        let path = root.join(file);
        let im = aditor::cv::read_png(&path, false).unwrap();
        let (banner, spec) = if file.ends_with("_banner.png") {
            let spec = if file == "mixtape/self_banner.png" {
                root.join("mixtape/assist_spec.png")
            } else {
                root.join(file.replace("_banner.png", "_spec.png"))
            };
            (im, aditor::cv::read_png(&spec, false).unwrap())
        } else {
            (
                im.crop(0, 0, im.width, p.banner_roi[3] as usize).unwrap(),
                im.crop(
                    0,
                    p.banner_roi[3] as usize,
                    p.spec_roi[2] as usize,
                    im.height - p.banner_roi[3] as usize,
                )
                .unwrap(),
            )
        };
        let (prepared, features) = det.prepare(&banner, &spec).unwrap();
        close(
            &frame_json(det.resolve(&prepared).unwrap()),
            &c["expected"],
            file,
        );
        close(&json!(features), &c["icon"], file);
        if let Some(learned) = &learned {
            close(
                &frame_json(learned.resolve(&prepared).unwrap()),
                &c["learned"],
                file,
            );
        }
        close(
            &mix.detect(&banner, &spec)
                .unwrap()
                .map_or(Value::Null, frame_json),
            &c["mixtape"],
            file,
        );
    }
}
#[test]
fn english_reference_crops() {
    detection_reference_crops("en");
}
#[test]
fn japanese_reference_crops() {
    detection_reference_crops("ja");
}
#[test]
fn traditional_chinese_reference_crops() {
    detection_reference_crops("zh-TW");
}
#[test]
fn mixtape_reference_crops() {
    detection_reference_crops("mixtape");
}

#[test]
fn english_mixtape_fading_names_and_replacement() {
    let p = common::profile();
    let detector = Detector::new(&p, 1., None, None).unwrap();
    let mut tracker = EventTracker::new(&p, None);
    let refs = cases();
    let c = &refs["mixtape_transitions"];
    for f in c["frames"].as_array().unwrap() {
        let image = aditor::cv::read_png(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/parity")
                .join(f[1].as_str().unwrap()),
            false,
        )
        .unwrap();
        let banner = image.crop(0, 0, 800, 180).unwrap();
        let spec = image.crop(0, 180, 480, 118).unwrap();
        tracker.feed(
            f[0].as_f64().unwrap(),
            detector.detect(&banner, &spec).unwrap(),
        );
    }
    let (events, spec) = tracker.finish();
    close(
        &json!([events, spec]),
        &c["expected"],
        "English Mixtape transitions",
    );
}
#[test]
fn colorblind_name_signatures() {
    let p = common::profile();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/colorblind");
    let labels: Value =
        serde_json::from_slice(&std::fs::read(root.join("labels.json")).unwrap()).unwrap();
    assert_eq!(labels.as_object().unwrap().len(), 22);
    let mut sigs = vec![];
    for name in labels.as_object().unwrap().keys() {
        assert!(std::fs::metadata(root.join(name)).unwrap().len() < 50_000);
        let im = aditor::cv::read_png(&root.join(name), false).unwrap();
        if labels[name]["mode"] == "green_blind_pink" {
            assert!(detect::name_sig_from_row(&im, &p, true).unwrap().is_some());
        }
        let sig = detect::read_name_sig(&im, &p).unwrap().unwrap();
        assert!(
            sig.bits.iter().map(|&b| b as usize).sum::<usize>() as f64 / sig.bits.len() as f64
                >= 0.12,
            "{name}"
        );
        let mut plain = p.clone();
        plain.red.as_object_mut().unwrap().remove("pink");
        if labels[name]["mode"] != "green_blind_pink" {
            assert_eq!(detect::read_name_sig(&im, &plain).unwrap().unwrap(), sig);
        }
        sigs.push((name, sig));
    }
    let mut mode_scores: std::collections::BTreeMap<String, Vec<f64>> =
        std::collections::BTreeMap::new();
    for (i, (a, sa)) in sigs.iter().enumerate() {
        for (b, sb) in &sigs[i + 1..] {
            if labels[*a]["mode"] != labels[*b]["mode"] {
                continue;
            }
            if labels[*a]["name"] != labels[*b]["name"] {
                assert!(
                    !detect::same_name(Some(sa), Some(sb), p.name_sig_threshold),
                    "{a} {b}"
                );
            } else {
                let mode = labels[*a]["mode"].as_str().unwrap();
                mode_scores
                    .entry(mode.into())
                    .or_default()
                    .push(detect::name_sig_similarity(sa, sb));
                if mode == "green_blind_pink" {
                    assert!(
                        detect::same_name(Some(sa), Some(sb), p.name_sig_threshold),
                        "{a} {b}"
                    );
                }
            }
        }
    }
    assert_eq!(mode_scores.len(), 3);
    for (mode, scores) in mode_scores {
        assert!(
            scores.iter().sum::<f64>() / scores.len() as f64 >= 0.4,
            "{mode}"
        );
    }
}

#[test]
fn learned_keywords_reference_languages() {
    let p = common::profile();
    let det = Detector::new(&p, 1., None, None).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for c in cases()["keywords"].as_array().unwrap() {
        let mut col = aditor::calibrate::AnchorCollector::default();
        for (i, path) in c["anchors"].as_array().unwrap().iter().enumerate() {
            let im = aditor::cv::read_png(&root.join(path.as_str().unwrap()), false).unwrap();
            col.feed(
                i as f64 * 10.,
                &im.crop(0, 0, im.width, p.banner_roi[3] as usize).unwrap(),
                &det,
            )
            .unwrap();
        }
        assert_eq!(
            aditor::calibrate::build_keywords(&[col]).unwrap().to_dict(),
            c["expected"],
            "{}",
            c["lang"]
        );
    }
}

#[test]
fn control_feed_reference_crops() {
    let p = common::profile();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_feed");
    for c in cases()["control"].as_array().unwrap() {
        let name = c["file"].as_str().unwrap();
        let feed = aditor::cv::read_png(&root.join(name), false).unwrap();
        let spec = aditor::cv::read_png(&root.join(name.replace("_feed", "_spec")), false).unwrap();
        let mut detector = aditor::control_feed::ControlFeed::new(&p).unwrap();
        for t in [0., 0.25] {
            detector.feed(t, Some(&feed), &spec, None).unwrap();
        }
        assert_eq!(json!(detector.active), c["active"], "{name}");
        close(&json!(detector.events), &c["events"], name);
    }
}

#[test]
fn segment_ownership_matches_single_pass_for_every_job_count() {
    let p = common::profile();
    let c = cases();
    let script = c["segments"]["frames"].as_array().unwrap();
    for jobs in 1..=4 {
        let plan = aditor::analyze::plan_segments(60., jobs, 5.);
        let mut all = vec![];
        let mut intervals = vec![];
        for (i, &(start, end)) in plan.iter().enumerate() {
            let seg = aditor::analyze::Segment::new(start, end, i + 1 == plan.len(), 60.);
            let mut tracker = EventTracker::new(&p, None);
            for f in script {
                let t = f[0].as_f64().unwrap();
                if t >= seg.resume_plan().1 && t < seg.decode_end().unwrap_or(60.) {
                    tracker.feed(t, frame(&f[1]));
                }
            }
            let (events, spec) = tracker.finish();
            all.extend(events.into_iter().filter(|e| seg.owns(e.t)));
            intervals.extend(aditor::analyze::clip_intervals(&spec, start, end));
        }
        all.sort_by(|a, b| a.t.total_cmp(&b.t));
        let spec = aditor::analyze::merge_intervals(intervals);
        assert_eq!(
            json!(derive::derive(&all, &spec, &p)),
            revive_aware_expected(c["segments"]["expected"].clone()),
            "jobs={jobs}"
        );
    }
}

#[test]
fn resumed_ownership_replaces_the_overlap_without_duplicates() {
    let p = common::profile();
    let c = cases();
    let script = c["segments"]["frames"].as_array().unwrap();
    let mut initial = EventTracker::new(&p, None);
    for f in script {
        let t = f[0].as_f64().unwrap();
        if t <= 40. {
            initial.feed(t, frame(&f[1]));
        }
    }
    let (old, _) = initial.snapshot();
    let mut seg = aditor::analyze::Segment::new(0., 60., true, 60.);
    seg.snap_progress = 40.;
    seg.own_from = seg.resume_plan().0;
    let mut all: Vec<_> = old
        .into_iter()
        .filter(|e| e.t < seg.own_from - 1e-6)
        .collect();
    let mut replay = EventTracker::new(&p, None);
    for f in script {
        let t = f[0].as_f64().unwrap();
        if t >= seg.resume_plan().1 {
            replay.feed(t, frame(&f[1]));
        }
    }
    all.extend(replay.finish().0.into_iter().filter(|e| seg.owns(e.t)));
    all.sort_by(|a, b| a.t.total_cmp(&b.t));
    assert_eq!(
        json!(derive::derive(&all, &[], &p)),
        revive_aware_expected(c["segments"]["expected"].clone())
    );
}
