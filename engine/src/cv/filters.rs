use super::{Image, Pixel};
use anyhow::{ensure, Result};
pub fn rect_kernel(width: usize, height: usize) -> Result<Image<u8>> {
    Image::new(width, height, 1, vec![1; width * height])
}
fn morph(src: &Image<u8>, kernel: &Image<u8>, dilate: bool) -> Image<u8> {
    if kernel.data.iter().all(|&v| v != 0) {
        return rect_morph(src, kernel.width, kernel.height, dilate);
    }

    let mut out = src.clone();
    for y in 0..src.height {
        for x in 0..src.width {
            for c in 0..src.channels {
                let mut best = if dilate { 0 } else { 255 };
                for ky in 0..kernel.height {
                    for kx in 0..kernel.width {
                        if kernel.data[ky * kernel.width + kx] == 0 {
                            continue;
                        }
                        let ix = x as isize + kx as isize - (kernel.width / 2) as isize;
                        let iy = y as isize + ky as isize - (kernel.height / 2) as isize;
                        if ix >= 0 && iy >= 0 && ix < src.width as isize && iy < src.height as isize
                        {
                            let v = src.data
                                [(iy as usize * src.width + ix as usize) * src.channels + c];
                            best = if dilate { best.max(v) } else { best.min(v) };
                        }
                    }
                }
                out.data[(y * src.width + x) * src.channels + c] = best;
            }
        }
    }
    out
}
fn rect_morph(src: &Image<u8>, kw: usize, kh: usize, dilate: bool) -> Image<u8> {
    let neutral = if dilate { 0 } else { 255 };
    let mut horizontal = src.clone();
    horizontal.data.fill(neutral);
    let combine = |dst: &mut [u8], values: &[u8]| {
        if dilate {
            for (a, b) in dst.iter_mut().zip(values) {
                *a = (*a).max(*b);
            }
        } else {
            for (a, b) in dst.iter_mut().zip(values) {
                *a = (*a).min(*b);
            }
        }
    };
    for k in 0..kw {
        let dx = k as isize - (kw / 2) as isize;
        let start = (-dx).max(0) as usize;
        let end = (src.width as isize - dx).min(src.width as isize).max(0) as usize;
        if start >= end {
            continue;
        }
        for y in 0..src.height {
            let a = (y * src.width + start) * src.channels;
            let b = (y * src.width + (start as isize + dx) as usize) * src.channels;
            let n = (end - start) * src.channels;
            combine(&mut horizontal.data[a..a + n], &src.data[b..b + n]);
        }
    }
    let mut out = src.clone();
    out.data.fill(neutral);
    let stride = src.width * src.channels;
    for k in 0..kh {
        let dy = k as isize - (kh / 2) as isize;
        let start = (-dy).max(0) as usize;
        let end = (src.height as isize - dy).min(src.height as isize).max(0) as usize;
        if start >= end {
            continue;
        }
        let a = start * stride;
        let b = (start as isize + dy) as usize * stride;
        let n = (end - start) * stride;
        combine(&mut out.data[a..a + n], &horizontal.data[b..b + n]);
    }
    out
}
pub fn dilate(src: &Image<u8>, kernel: &Image<u8>, iterations: usize) -> Image<u8> {
    let mut out = src.clone();
    for _ in 0..iterations {
        out = morph(&out, kernel, true);
    }
    out
}
#[derive(Clone, Copy, Debug)]
pub enum Morphology {
    Open,
    TopHat,
    BlackHat,
}
pub fn morphology(src: &Image<u8>, kernel: &Image<u8>, op: Morphology) -> Image<u8> {
    let black = matches!(op, Morphology::BlackHat);
    let out = morph(&morph(src, kernel, black), kernel, !black);
    match op {
        Morphology::Open => out,
        _ => Image {
            data: src
                .data
                .iter()
                .zip(out.data)
                .map(|(&a, b)| {
                    if black {
                        b.saturating_sub(a)
                    } else {
                        a.saturating_sub(b)
                    }
                })
                .collect(),
            ..src.clone()
        },
    }
}
fn reflect101(mut p: isize, n: usize) -> usize {
    if n == 1 {
        return 0;
    }
    while p < 0 || p >= n as isize {
        p = if p < 0 { -p } else { 2 * n as isize - p - 2 };
    }
    p as usize
}
pub fn box_filter(
    src: &Image<f32>,
    kernel: (usize, usize),
    anchor: (usize, usize),
) -> Result<Image<f32>> {
    ensure!(
        kernel.0 > 0 && kernel.1 > 0 && anchor.0 < kernel.0 && anchor.1 < kernel.1,
        "Invalid box kernel"
    );
    // Mixtape uses wide kernels; sliding sums avoid rescanning the same pixels per window.
    if !src.data.is_empty() && src.data.iter().all(|v| v.is_finite()) {
        let mut rows = vec![0f64; src.data.len()];
        let mut out = src.clone();
        for y in 0..src.height {
            for c in 0..src.channels {
                let pixel = |x| {
                    src.data[(y * src.width + reflect101(x, src.width)) * src.channels + c] as f64
                };
                let mut sum = (0..kernel.0)
                    .map(|k| pixel(k as isize - anchor.0 as isize))
                    .sum::<f64>();
                for x in 0..src.width {
                    rows[(y * src.width + x) * src.channels + c] = sum;
                    sum -= pixel(x as isize - anchor.0 as isize);
                    sum += pixel((x + kernel.0) as isize - anchor.0 as isize);
                }
            }
        }
        for x in 0..src.width {
            for c in 0..src.channels {
                let pixel =
                    |y| rows[(reflect101(y, src.height) * src.width + x) * src.channels + c];
                let mut sum = (0..kernel.1)
                    .map(|k| pixel(k as isize - anchor.1 as isize))
                    .sum::<f64>();
                for y in 0..src.height {
                    out.data[(y * src.width + x) * src.channels + c] =
                        (sum / (kernel.0 * kernel.1) as f64) as f32;
                    sum -= pixel(y as isize - anchor.1 as isize);
                    sum += pixel((y + kernel.1) as isize - anchor.1 as isize);
                }
            }
        }
        return Ok(out);
    }
    let mut out = src.clone();
    for y in 0..src.height {
        for x in 0..src.width {
            for c in 0..src.channels {
                let mut sum = 0f64;
                for ky in 0..kernel.1 {
                    for kx in 0..kernel.0 {
                        let ix =
                            reflect101(x as isize + kx as isize - anchor.0 as isize, src.width);
                        let iy =
                            reflect101(y as isize + ky as isize - anchor.1 as isize, src.height);
                        sum += src.data[(iy * src.width + ix) * src.channels + c] as f64;
                    }
                }
                out.data[(y * src.width + x) * src.channels + c] =
                    (sum / (kernel.0 * kernel.1) as f64) as f32;
            }
        }
    }
    Ok(out)
}
fn gaussian_kernel(n: usize, sigma: f64) -> Vec<f64> {
    if sigma <= 0. {
        match n {
            1 => return vec![1.],
            3 => return vec![0.25, 0.5, 0.25],
            5 => return vec![0.0625, 0.25, 0.375, 0.25, 0.0625],
            7 => {
                return vec![
                    0.03125, 0.109375, 0.21875, 0.28125, 0.21875, 0.109375, 0.03125,
                ]
            }
            _ => {}
        }
    }
    let sigma = if sigma > 0. {
        sigma
    } else {
        0.3 * ((n as f64 - 1.) * 0.5 - 1.) + 0.8
    };
    let mut k: Vec<f64> = (0..n)
        .map(|i| {
            let x = i as f64 - (n - 1) as f64 / 2.;
            (-0.5 * x * x / (sigma * sigma)).exp()
        })
        .collect();
    let sum: f64 = k.iter().sum();
    for v in &mut k {
        *v /= sum;
    }
    k
}
pub fn gaussian_blur<T: Pixel>(
    src: &Image<T>,
    size: (usize, usize),
    sigma: f64,
) -> Result<Image<T>> {
    ensure!(
        size.0 > 0 && size.1 > 0 && size.0 % 2 == 1 && size.1 % 2 == 1,
        "Invalid Gaussian kernel"
    );
    let kx = gaussian_kernel(size.0, sigma);
    let ky = gaussian_kernel(size.1, sigma);
    let mut out = src.clone();
    for y in 0..src.height {
        for x in 0..src.width {
            for c in 0..src.channels {
                let mut sum = 0f64;
                for (j, &b) in ky.iter().enumerate() {
                    for (i, &a) in kx.iter().enumerate() {
                        let ix =
                            reflect101(x as isize + i as isize - (size.0 / 2) as isize, src.width);
                        let iy =
                            reflect101(y as isize + j as isize - (size.1 / 2) as isize, src.height);
                        let (a, b) = if T::INTEGER {
                            (
                                (a * 256.).round_ties_even() / 256.,
                                (b * 256.).round_ties_even() / 256.,
                            )
                        } else {
                            (a as f32 as f64, b as f32 as f64)
                        };
                        sum += src.data[(iy * src.width + ix) * src.channels + c].float() as f64
                            * a
                            * b;
                    }
                }
                out.data[(y * src.width + x) * src.channels + c] = if T::INTEGER {
                    T::cast((sum + 0.5).floor() as f32)
                } else {
                    T::cast(sum as f32)
                };
            }
        }
    }
    Ok(out)
}
