mod common;
use aditor::{
    analyze::{self, analyze, AnalyzeOptions},
    cache,
    errors::Cancelled,
    layout::Layout,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
fn video() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/media/knocks.mp4")
}
fn options(dir: &Path) -> AnalyzeOptions<'_> {
    AnalyzeOptions {
        hwaccel: false,
        game: Some("apex"),
        layout: Some(Layout::default()),
        jobs: Some(1),
        ..AnalyzeOptions::new(dir)
    }
}
#[test]
fn cancellation_writes_partial_and_resume_has_no_duplicates() {
    let tmp = common::TempDir::new();
    let p = common::profile();
    let video = video();
    let path = video.to_str().unwrap();
    let cancel = AtomicBool::new(true);
    let error = analyze(
        path,
        &p,
        AnalyzeOptions {
            cancel: Some(&cancel),
            ..options(&tmp.0)
        },
    )
    .unwrap_err();
    assert!(error.is::<Cancelled>());
    let cp = cache::cache_path(path, &tmp.0, false);
    let partial = cache::load_cache(&cp).unwrap();
    assert_eq!(partial["analysis"]["status"], "partial");
    assert_eq!(partial["analysis"]["progress_t"], 0.);
    let doc = analyze(path, &p, options(&tmp.0)).unwrap();
    assert_eq!(doc["events"].as_array().unwrap().len(), 2);
    assert_eq!(doc["analysis"]["status"], "done");
    assert_eq!(analyze(path, &p, options(&tmp.0)).unwrap(), doc);
}
#[test]
fn forced_reanalysis_preserves_user_edits_even_across_cancellation() {
    let tmp = common::TempDir::new();
    let p = common::profile();
    let video = video();
    let path = video.to_str().unwrap();
    let mut doc = analyze(path, &p, options(&tmp.0)).unwrap();
    doc["events"][0]["deleted"] = true.into();
    doc["events"][1]["counted_override"] = true.into();
    doc["clips"] = json!([{"id":"manual","start":0.,"end":5.,"origin":"manual","event_ids":[]}]);
    cache::save_cache(&cache::cache_path(path, &tmp.0, false), &doc, None).unwrap();
    let cancel = AtomicBool::new(true);
    assert!(analyze(
        path,
        &p,
        AnalyzeOptions {
            force: true,
            cancel: Some(&cancel),
            ..options(&tmp.0)
        }
    )
    .unwrap_err()
    .is::<Cancelled>());
    let result = analyze(path, &p, options(&tmp.0)).unwrap();
    assert_eq!(result["events"][0]["deleted"], true);
    assert_eq!(result["events"][1]["counted_override"], true);
    assert_eq!(result["clips"], doc["clips"]);
    assert_eq!(result["unmatched"], json!([]));
}
#[test]
fn progress_is_throttled_and_finishes_at_duration() {
    let tmp = common::TempDir::new();
    let calls = Mutex::new(vec![]);
    let progress = |t, d| calls.lock().unwrap().push((t, d));
    analyze(
        video().to_str().unwrap(),
        &common::profile(),
        AnalyzeOptions {
            on_progress: &progress,
            jobs: Some(2),
            ..options(&tmp.0)
        },
    )
    .unwrap();
    let calls = calls.into_inner().unwrap();
    assert_eq!(calls.last(), Some(&(12., 12.)));
    assert!(calls.len() < 12 * 4 + 2);
}
#[test]
fn cancellation_during_learning_restarts_without_false_progress() {
    let tmp = common::TempDir::new();
    let cancel = AtomicBool::new(false);
    let progress = |_, _| cancel.store(true, Ordering::Relaxed);
    let path = video();
    let path = path.to_str().unwrap();
    assert!(analyze(
        path,
        &common::profile(),
        AnalyzeOptions {
            on_progress: &progress,
            cancel: Some(&cancel),
            ..options(&tmp.0)
        }
    )
    .unwrap_err()
    .is::<Cancelled>());
    let partial = cache::load_cache(&cache::cache_path(path, &tmp.0, false)).unwrap();
    assert_eq!(partial["analysis"]["progress_t"], 0.);
    assert_eq!(partial["events"], json!([]));
}
#[test]
fn segment_planning_ownership_and_interval_operations() {
    use aditor::models::SpecInterval;
    use analyze::*;
    assert_eq!(
        plan_segments(60., 4, 5.),
        vec![(0., 15.), (15., 30.), (30., 45.), (45., 60.)]
    );
    assert_eq!(plan_segments(6., 4, 30.), vec![(0., 6.)]);
    let mut s = Segment::new(20., 40., false, 60.);
    assert_eq!(s.resume_plan(), (20., 0.));
    s.own_from = 20.;
    assert!(s.owns(20.));
    assert!(!s.owns(40.));
    assert_eq!(s.decode_end(), Some(52.));
    s.snap_progress = 45.;
    assert_eq!(s.resume_plan(), (33., 13.));
    assert!(restore(
        &json!([{"start":0.,"end":30.,"progress_t":12.},{"start":31.,"end":60.,"progress_t":31.}]),
        60.
    )
    .is_none());
    let restored = restore(
        &json!([{"start":0.,"end":30.,"progress_t":42.},{"start":30.,"end":60.,"progress_t":40.}]),
        60.,
    )
    .unwrap();
    assert!(restored[0].done());
    assert!(!restored[1].done());
    let items = vec![
        SpecInterval {
            start: 0.,
            end: 10.,
        },
        SpecInterval {
            start: 12.,
            end: 20.,
        },
    ];
    assert_eq!(
        json!(clip_intervals(&items, 5., 15.)),
        json!([{"start":5.,"end":10.},{"start":12.,"end":15.}])
    );
    assert_eq!(
        json!(cut_intervals(&items, 5., 15.)),
        json!([{"start":0.,"end":5.},{"start":15.,"end":20.}])
    );
}

#[test]
fn partial_keywords_resume_and_corrupt_templates_restart_safely() {
    let tmp = common::TempDir::new();
    let p = common::profile();
    let video = video();
    let path = video.to_str().unwrap();
    let full = analyze(path, &p, options(&tmp.0)).unwrap();
    let cp = cache::cache_path(path, &tmp.0, false);
    for corrupt in [false, true] {
        let mut partial = full.clone();
        partial["analysis"]["status"] = "partial".into();
        partial["analysis"]["progress_t"] = 4.0.into();
        partial["events"].as_array_mut().unwrap().truncate(1);
        if corrupt {
            partial["analysis"]["keywords"] = json!({"knock":{"shape":[2,2],"q8":"bad"}});
        }
        cache::save_cache(&cp, &partial, None).unwrap();
        let resumed = analyze(path, &p, options(&tmp.0)).unwrap();
        assert_eq!(resumed["events"], full["events"]);
        assert_eq!(
            resumed["analysis"]["keywords"],
            full["analysis"]["keywords"]
        );
    }
}
fn golden(jobs: Option<usize>) {
    let Ok(path) = std::env::var("ADITOR_GOLDEN_VIDEO") else {
        return;
    };
    if !Path::new(&path).is_file() {
        return;
    }
    let temp = common::TempDir::new();
    let doc = analyze(
        &path,
        &common::profile(),
        AnalyzeOptions {
            jobs,
            ..options(&temp.0)
        },
    )
    .unwrap();
    let expected: Value = serde_json::from_str(include_str!("golden/expected.json")).unwrap();
    let product = ["knock", "assist_knock", "assist_elim"];
    let mut got = doc["events"].as_array().unwrap().clone();
    assert!(got
        .iter()
        .all(|e| product.contains(&e["type"].as_str().unwrap())));
    for e in expected["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| product.contains(&e["type"].as_str().unwrap()))
    {
        let hit = got
            .iter()
            .position(|g| {
                g["type"] == e["type"]
                    && (g["t"].as_f64().unwrap() - e["t"].as_f64().unwrap()).abs() <= 0.5
            })
            .expect("missing golden event");
        got.remove(hit);
    }
    assert!(got
        .iter()
        .all(|e| [39., 98.25, 138.5, 166.5]
            .iter()
            .any(|t| (e["t"].as_f64().unwrap() - t).abs() <= 0.5)));
}
#[test]
#[ignore = "slow: requires ADITOR_GOLDEN_VIDEO"]
fn golden_jobs_one() {
    golden(Some(1));
}
#[test]
#[ignore = "slow: requires ADITOR_GOLDEN_VIDEO"]
fn golden_jobs_auto() {
    golden(None);
}
