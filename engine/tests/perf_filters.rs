use aditor::cv::{self, Image, Morphology};
use std::{hint::black_box, time::Instant};

fn bench(name: &str, mut run: impl FnMut()) {
    const ITERATIONS: usize = 20;
    run();
    let mut samples = Vec::new();
    for _ in 0..9 {
        let start = Instant::now();
        for _ in 0..ITERATIONS {
            run();
        }
        samples.push(start.elapsed().as_secs_f64() * 1e6 / ITERATIONS as f64);
    }
    samples.sort_by(f64::total_cmp);
    println!("BENCH {name} {:.3}", samples[samples.len() / 2]);
}

#[test]
#[ignore]
fn filters() {
    for (w, h) in [(800, 180), (1920, 1080), (480, 118)] {
        let data = (0..w * h)
            .map(|i| {
                if (i * 17 + i / w * 31) % 101 < 65 {
                    255
                } else {
                    0
                }
            })
            .collect();
        let src = Image::new(w, h, 1, data).unwrap();
        if w != 480 {
            let horizontal = cv::rect_kernel(81, 1).unwrap();
            let vertical = cv::rect_kernel(1, 5).unwrap();
            bench(&format!("open81x1_then1x5_{w}x{h}"), || {
                let lines = cv::morphology(black_box(&src), &horizontal, Morphology::Open);
                black_box(cv::morphology(&lines, &vertical, Morphology::Open));
            });
        }
        if w != 1920 {
            let kernel = cv::rect_kernel(7, 7).unwrap();
            bench(&format!("tophat7x7_{w}x{h}"), || {
                black_box(cv::morphology(black_box(&src), &kernel, Morphology::TopHat));
            });
        }
        if w == 480 {
            for k in [3, 5] {
                let kernel = cv::rect_kernel(k, k).unwrap();
                bench(&format!("open{k}x{k}_{w}x{h}"), || {
                    black_box(cv::morphology(black_box(&src), &kernel, Morphology::Open));
                });
            }
        }
    }
    let src = Image::new(
        480,
        30,
        1,
        (0..480 * 30).map(|i| (i % 251) as f32 / 251.).collect(),
    )
    .unwrap();
    bench("gaussian3x3_f32_480x30", || {
        black_box(cv::gaussian_blur(black_box(&src), (3, 3), 0.8).unwrap());
    });
}
