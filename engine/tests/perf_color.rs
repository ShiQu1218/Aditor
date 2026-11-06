mod common;

use aditor::{cv, detect};
use std::{hint::black_box, time::Instant};

fn bench(name: &str, mut run: impl FnMut() -> cv::Image<u8>) {
    const ITERATIONS: usize = 100;
    black_box(run());
    let mut samples = Vec::new();
    for _ in 0..9 {
        let start = Instant::now();
        for _ in 0..ITERATIONS {
            black_box(run());
        }
        samples.push(start.elapsed().as_secs_f64() * 1e6 / ITERATIONS as f64);
    }
    samples.sort_by(f64::total_cmp);
    println!("BENCH {name} {:.3}", samples[samples.len() / 2]);
}

fn image(width: usize, height: usize) -> cv::Image<u8> {
    let mut seed = 20261106u32;
    let data = (0..width * height * 3)
        .map(|_| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 24) as u8
        })
        .collect();
    cv::Image::new(width, height, 3, data).unwrap()
}

#[test]
#[ignore]
fn color() {
    let profile = common::profile();
    for (width, height) in [(800, 180), (480, 118), (1920, 80)] {
        let src = image(width, height);
        bench(&format!("hsv_{width}x{height}"), || {
            cv::hsv(black_box(&src)).unwrap()
        });
    }
    for (width, height) in [(480, 118), (800, 30)] {
        let src = image(width, height);
        bench(&format!("white_mask_{width}x{height}"), || {
            detect::white_mask(black_box(&src), black_box(&profile.white)).unwrap()
        });
    }
}
