mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{
    layout::Layout,
    live::{KillLimits, LiveKills},
    scene::SceneMatcher,
};
#[test]
#[ignore = "slow: run in release mode to compare fixture-frame detection CPU time"]
fn fixture_frame_detection_performance() {
    let python: serde_json::Value =
        serde_json::from_str(include_str!("parity/phase_c/performance.json")).unwrap();
    let p = common::profile();
    let calls = parity::cases()["live_kills"][1]["calls"]
        .as_array()
        .unwrap();
    let b = parity::image(calls[0]["banner"].as_str().unwrap());
    let s = parity::image(calls[0]["spec"].as_str().unwrap());
    let scene = SceneMatcher::new(None).unwrap();
    let f = parity::screen(parity::cases()["scene"][0]["file"].as_str().unwrap());
    let mut results = vec![];
    for _ in 0..3 {
        let mut k = LiveKills::new(&p, KillLimits::default()).unwrap();
        let start = aditor::live::process_cpu_seconds().unwrap();
        for i in 0..20 {
            k.feed(i as f64 * 0.25, &b, &s, None, None).unwrap();
            if i % 4 == 0 {
                scene.classify_frame(&f, Layout::default(), false).unwrap();
            }
        }
        results.push((aditor::live::process_cpu_seconds().unwrap() - start) * 1000. / 20.);
    }
    results.sort_by(f64::total_cmp);
    assert!(
        results[1] <= python["python_ms"].as_f64().unwrap(),
        "Rust {:?} vs Python {}",
        results,
        python
    );
    println!("Python reference: {python}");
    println!(
        "Rust release median ms/frame: {:.6}; runs: {:?}",
        results[1], results
    );
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/phase-c-performance.json");
    std::fs::write(
        path,
        serde_json::to_string(
            &serde_json::json!({"rust_ms":results[1],"runs":results,"python":python}),
        )
        .unwrap(),
    )
    .unwrap();
}
#[test]
#[ignore = "slow: run in release mode; wall ms/frame with unique frames so per-frame caches cannot hit"]
fn unique_frame_detection_performance() {
    let p = common::profile();
    let frames: Vec<_> = parity::cases()["frames"]
        .as_object()
        .unwrap()
        .keys()
        .map(|k| parity::image(k))
        .collect();
    let pick = |w, h| -> Vec<_> {
        frames
            .iter()
            .filter(|i| i.width == w && i.height == h && i.channels == 3)
            .collect()
    };
    let (banners, specs) = (pick(800, 180), pick(480, 118));
    // Live frames never repeat; flip sparse low bits so every ROI crop differs between calls.
    let unique = |src: &[&aditor::cv::Image<u8>], i: usize| {
        let mut im = src[i % src.len()].clone();
        for q in (0..im.data.len()).step_by(97) {
            im.data[q] ^= ((i >> (q % 10)) & 1) as u8;
        }
        im
    };
    let n = 200;
    let inputs: Vec<_> = (0..n)
        .map(|i| (unique(&banners, i), unique(&specs, i)))
        .collect();
    let mut results = vec![];
    for _ in 0..3 {
        let mut k = LiveKills::new(&p, KillLimits::default()).unwrap();
        let start = std::time::Instant::now();
        for (i, (b, s)) in inputs.iter().enumerate() {
            k.feed(i as f64 * 0.25, b, s, None, None).unwrap();
        }
        results.push(start.elapsed().as_secs_f64() * 1000. / n as f64);
    }
    results.sort_by(f64::total_cmp);
    println!(
        "Unique-frame wall median ms/frame: {:.4}; runs: {:?}",
        results[1], results
    );
}
