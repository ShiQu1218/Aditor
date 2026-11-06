mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{
    layout::Layout,
    live::{KillLimits, LiveKills},
    scene::SceneMatcher,
};
use std::sync::Mutex;
// `process_cpu_seconds` is process-wide, so serialize benchmarks when run without `--test-threads=1`.
static SERIAL: Mutex<()> = Mutex::new(());
#[test]
#[ignore = "slow: run in release mode to compare fixture-frame detection CPU time"]
fn fixture_frame_detection_performance() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
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
    unique_frames(false);
}
#[test]
#[ignore = "slow: run in release mode; unique spectating frames with mixtape HUD and banners"]
fn spectating_unique_frame_detection_performance() {
    unique_frames(true);
}
fn unique_frames(spectating: bool) {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let p = common::profile();
    // Live frames never repeat; flip sparse low bits so every ROI crop differs between calls.
    let unique = |src: &[&aditor::cv::Image<u8>], i: usize| {
        let mut im = src[i % src.len()].clone();
        for q in (0..im.data.len()).step_by(97) {
            im.data[q] ^= ((i >> (q % 10)) & 1) as u8;
        }
        im
    };
    let n = 200;
    let inputs: Vec<_> = if spectating {
        let root = parity::root().join("fixtures/mixtape");
        let b = aditor::cv::read_png(&root.join("kill_banner.png"), false).unwrap();
        let mut s = aditor::cv::read_png(&root.join("kill_spec.png"), false).unwrap();
        let tpl = aditor::cv::read_png(&p.dir.join("spec_en_next_mate.png"), true).unwrap();
        for y in 0..tpl.height {
            for x in 0..tpl.width {
                let start = ((y + 80) * s.width + x + 112) * 3;
                s.data[start..start + 3].fill(tpl.data[y * tpl.width + x]);
            }
        }
        (0..n)
            .map(|i| (unique(&[&b], i), unique(&[&s], i)))
            .collect()
    } else {
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
        (0..n)
            .map(|i| (unique(&banners, i), unique(&specs, i)))
            .collect()
    };
    let mut results = vec![];
    // The spectating case must reach the detection phase; calibration would bypass the
    // spectating check and run the mixtape matcher regardless.
    let limits = if spectating {
        KillLimits {
            calib_scan: 0.,
            learn_seconds: 0.,
            ..KillLimits::default()
        }
    } else {
        KillLimits::default()
    };
    for _ in 0..3 {
        let mut k = LiveKills::new(&p, limits).unwrap();
        let start = std::time::Instant::now();
        for (i, (b, s)) in inputs.iter().enumerate() {
            k.feed(i as f64 * 0.25, b, s, None, None).unwrap();
        }
        results.push(start.elapsed().as_secs_f64() * 1000. / n as f64);
    }
    if spectating {
        let detector = aditor::detect::Detector::new(&p, 1., None, None).unwrap();
        for (b, s) in &inputs {
            let result = detector.detect(b, s).unwrap();
            assert!(result.spectating);
            assert!(result.kind.is_none());
        }
    }
    results.sort_by(f64::total_cmp);
    println!(
        "Unique-frame wall median ms/frame (spectating={spectating}): {:.4}; runs: {:?}",
        results[1], results
    );
}
