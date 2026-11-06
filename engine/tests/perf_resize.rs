use aditor::cv::{resize, resize_factor, Image, Interpolation};
use std::{hint::black_box, time::Instant};

fn bench<T>(name: &str, iterations: usize, mut run: impl FnMut() -> T) {
    black_box(run());
    let mut samples = [0.; 9];
    for sample in &mut samples {
        let start = Instant::now();
        for _ in 0..iterations {
            black_box(run());
        }
        *sample = start.elapsed().as_secs_f64() * 1e6 / iterations as f64;
    }
    samples.sort_by(f64::total_cmp);
    println!("BENCH {name} {:.3}", samples[4]);
}

#[test]
#[ignore = "micro-benchmark: run in release mode"]
fn resize_performance() {
    for (name, w, h, c, factor, iterations) in [
        ("u8_bgr_800x180_0.75_linear", 800, 180, 3, 0.75, 30),
        ("u8_bgr_800x180_1.33_linear", 800, 180, 3, 1.33, 30),
        ("u8_gray_480x118_2_linear", 480, 118, 1, 2., 30),
    ] {
        let src = Image::new(w, h, c, (0..w * h * c).map(|i| (i * 37) as u8).collect()).unwrap();
        bench(name, iterations, || {
            resize_factor(black_box(&src), factor, factor, Interpolation::Linear).unwrap()
        });
    }
    let src = Image::new(
        1920,
        1080,
        3,
        (0..1920 * 1080 * 3).map(|i| (i * 37) as u8).collect(),
    )
    .unwrap();
    bench("u8_bgr_1920x1080_1280x720_linear", 15, || {
        resize(black_box(&src), 1280, 720, Interpolation::Linear).unwrap()
    });
    bench("u8_bgr_1920x1080_half_area", 30, || {
        resize(black_box(&src), 960, 540, Interpolation::Area).unwrap()
    });
    let src = Image::new(
        200,
        50,
        1,
        (0..200 * 50).map(|i| (i % 257) as f32 / 257.).collect(),
    )
    .unwrap();
    bench("f32_gray_200x50_150x37_linear", 200, || {
        resize(black_box(&src), 150, 37, Interpolation::Linear).unwrap()
    });
}
