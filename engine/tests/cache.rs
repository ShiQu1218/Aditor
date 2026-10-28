mod common;
use aditor::{
    cache,
    models::{Clip, Event, VideoInfo},
};
use serde_json::{json, Value};

fn event(id: &str, t: f64, kind: &str) -> Event {
    serde_json::from_value(
        json!({"id":id,"t":t,"type":kind,"score":0.9,"damage_line":true,"name_sig":null}),
    )
    .unwrap()
}
fn doc(path: &str) -> Value {
    json!({"video":{"path":path,"size":10,"mtime":100.},"analysis":{"status":"done","engine_version":cache::ENGINE_VERSION,"templates_version":"icons@1"}})
}

#[test]
fn cache_paths_normalization_and_containers() {
    let tmp = common::TempDir::new();
    assert_eq!(
        cache::cache_path(r"D:\Videos\A.mp4", &tmp.0, false),
        cache::cache_path("d:/videos/a.MP4", &tmp.0, false)
    );
    let video = tmp.0.join("Apex 影片/a b.mp4");
    let video = video.to_str().unwrap();
    assert!(cache::cache_path(video, &tmp.0, true).ends_with("a b.mp4.aditor.json"));
    assert_ne!(
        cache::cache_path(video, &tmp.0, true),
        cache::cache_path(&video.replace(".mp4", ".mkv"), &tmp.0, true)
    );
}
#[test]
fn python_json_bytes_and_roundtrip() {
    let value = json!({"文字":"中文\n\t\u{1}","items":[null,true,1,1.0,-0.0,1e-7,1e16,1e15]});
    assert_eq!(String::from_utf8(cache::json_bytes(&value).unwrap()).unwrap(),"{\"文字\": \"中文\\n\\t\\u0001\", \"items\": [null, true, 1, 1.0, -0.0, 1e-07, 1e+16, 1000000000000000.0]}");
    let tmp = common::TempDir::new();
    let path = tmp.0.join("cache.json");
    cache::save_cache(&path, &value, None).unwrap();
    assert_eq!(cache::load_cache(&path), Some(value));
    std::fs::write(&path, b"[]").unwrap();
    assert!(cache::load_cache(&path).is_none());
    std::fs::write(&path, b"broken").unwrap();
    assert!(cache::load_cache(&path).is_none());
}
#[test]
fn resolve_legacy_requires_same_video_and_migration_preserves_edits() {
    let tmp = common::TempDir::new();
    let video = tmp.0.join("match.mp4");
    let path = video.to_str().unwrap();
    let dir = tmp.0.join("cache");
    let legacy = cache::legacy_cache_path(path, &dir, true);
    cache::save_cache(&legacy, &doc("other.mp4"), None).unwrap();
    assert_eq!(
        cache::resolve_cache_path(path, &dir, true),
        cache::cache_path(path, &dir, true)
    );
    let mut old = doc(path);
    old["events"] = json!([{"deleted":true}]);
    cache::save_cache(&legacy, &old, None).unwrap();
    let (target, migrated) = cache::prepare_cache(path, &dir, true);
    assert_eq!(target, cache::cache_path(path, &dir, true));
    assert_eq!(migrated.unwrap()["events"], old["events"]);
    assert!(legacy.exists());
}
#[test]
fn newest_cache_wins_with_preference_on_ties() {
    let tmp = common::TempDir::new();
    let path = tmp.0.join("v.mp4");
    let path = path.to_str().unwrap();
    let side = cache::cache_path(path, &tmp.0, true);
    let central = cache::cache_path(path, &tmp.0, false);
    for (p, seconds) in [(&central, 1000), (&side, 2000)] {
        cache::save_cache(p, &doc(path), None).unwrap();
        std::fs::File::options()
            .write(true)
            .open(p)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds))
            .unwrap();
    }
    assert_eq!(cache::resolve_cache_path(path, &tmp.0, false), side);
    std::fs::File::options()
        .write(true)
        .open(&central)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(2000))
        .unwrap();
    assert_eq!(cache::resolve_cache_path(path, &tmp.0, false), central);
}
#[test]
fn fallback_uses_video_key() {
    let tmp = common::TempDir::new();
    let blocked = tmp.0.join("blocked");
    std::fs::write(&blocked, []).unwrap();
    let fallback = tmp.0.join("fallback");
    let value = doc("影片.mp4");
    assert_eq!(
        cache::save_cache(&blocked.join("a.json"), &value, Some(&fallback)).unwrap(),
        cache::cache_path("影片.mp4", &fallback, false)
    );
}
#[test]
fn invalidation_checks_every_version_and_source_field() {
    let info = VideoInfo {
        size: 10,
        mtime: 100.,
        ..Default::default()
    };
    let good = doc("v");
    assert!(!cache::needs_reanalysis(
        Some(&good),
        &info,
        "icons@1",
        Some(1.),
        "apex"
    ));
    for (section, key, value) in [
        ("analysis", "status", json!("partial")),
        ("analysis", "engine_version", json!("old")),
        ("analysis", "templates_version", json!("old")),
        ("analysis", "aspect_squash", json!(0.8)),
        ("video", "size", json!(11)),
        ("video", "mtime", json!(101.)),
    ] {
        let mut bad = good.clone();
        bad[section][key] = value;
        assert!(
            cache::needs_reanalysis(Some(&bad), &info, "icons@1", Some(1.), "apex"),
            "{key}"
        );
    }
    let mut other = good.clone();
    other["game"] = json!("valorant");
    assert!(cache::needs_reanalysis(
        Some(&other),
        &info,
        "icons@1",
        None,
        "apex"
    ));
}
#[test]
fn reanalysis_matches_ids_before_nearby_family_and_preserves_manual() {
    let mut old = event("keep", 10., "assist_knock");
    old.deleted = true;
    old.counted_override = Some(false);
    let mut manual = event("manual", 5., "knock");
    manual.source = "manual".into();
    let (merged, unmatched) = cache::merge_reanalysis(
        &[old.clone(), manual.clone()],
        &[
            event("near", 10.1, "assist_elim"),
            event("keep", 10.5, "assist_knock"),
        ],
    );
    assert_eq!(merged[0], manual);
    assert!(!merged[1].deleted);
    assert!(merged[2].deleted);
    assert!(unmatched.is_empty());
    let (merged, unmatched) =
        cache::merge_reanalysis(&[old.clone()], &[event("new", 10.1, "assist_elim")]);
    assert!(merged[0].deleted);
    assert!(unmatched.is_empty());
    assert_eq!(cache::merge_reanalysis(&[old.clone()], &[]).1, vec![old]);
}
#[test]
fn clips_keep_manual_and_replace_auto() {
    let manual = Clip {
        id: "manual".into(),
        start: 5.,
        end: 10.,
        origin: "manual".into(),
        event_ids: vec![],
    };
    let auto = Clip {
        id: "auto".into(),
        origin: "auto".into(),
        ..manual.clone()
    };
    assert_eq!(
        cache::merge_clips(&[manual.clone(), auto], &[]),
        vec![manual]
    );
}

#[test]
fn cache_file_names_match_python_for_existing_user_caches() {
    // Expected names from Python `aditor.cache.cache_path`; a mismatch would orphan every user's cache.
    for (video, name) in [
        (
            r"D:\Videos\Apex\a.mp4",
            "4f02ebab136271c0f69ba48dee171dc8310b8249.json",
        ),
        (
            "d:/videos/apex/A.MP4",
            "4f02ebab136271c0f69ba48dee171dc8310b8249.json",
        ),
        (
            "C:/x/../y/\u{9304}\u{5f71} \u{c9} 1.mp4",
            "2cbd038bffe3ef9c0807ea7b70d4bbf24ae8b5a2.json",
        ),
        (
            "D:/A/./B.mp4",
            "31a8cc24ec8f3fbdb7ec13332a6c32e881da5de6.json",
        ),
    ] {
        let path = cache::cache_path(video, std::path::Path::new("."), false);
        assert_eq!(path.file_name().unwrap(), name, "{video}");
    }
}

#[test]
#[cfg(windows)]
fn parent_components_cannot_remove_the_drive_or_unc_root() {
    for (input, normalized) in [
        (r"C:\..\..\video.mp4", r"C:\video.mp4"),
        (r"\\?\C:\..\video.mp4", r"\\?\C:\video.mp4"),
        (r"C:\folder\..\..\video.mp4", r"C:\video.mp4"),
        (r"\\server\share\..\video.mp4", r"\\server\share\video.mp4"),
    ] {
        assert_eq!(
            cache::cache_path(input, std::path::Path::new("cache"), false),
            cache::cache_path(normalized, std::path::Path::new("cache"), false),
            "{input}",
        );
    }
}
