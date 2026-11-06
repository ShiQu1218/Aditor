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
fn rect_morph_axis(src: &[u8], out: &mut [u8], n: usize, lanes: usize, k: usize, dilate: bool) {
    let mut prefix = vec![0; n * lanes];
    let mut suffix = vec![0; n * lanes];
    let combine = |a: u8, b: u8| if dilate { a.max(b) } else { a.min(b) };
    for (src, out) in src
        .chunks_exact(n * lanes)
        .zip(out.chunks_exact_mut(n * lanes))
    {
        if lanes == 1 {
            for (block_index, block) in src.chunks(k).enumerate() {
                let start = block_index * k;
                let mut best = if dilate { 0 } else { 255 };
                for (dst, &value) in prefix[start..start + block.len()].iter_mut().zip(block) {
                    best = combine(best, value);
                    *dst = best;
                }
                best = if dilate { 0 } else { 255 };
                for (dst, &value) in suffix[start..start + block.len()]
                    .iter_mut()
                    .zip(block)
                    .rev()
                {
                    best = combine(best, value);
                    *dst = best;
                }
            }
        } else {
            for start in (0..n).step_by(k) {
                let end = start.saturating_add(k).min(n);
                prefix[start * lanes..(start + 1) * lanes]
                    .copy_from_slice(&src[start * lanes..(start + 1) * lanes]);
                for x in start + 1..end {
                    let (before, after) = prefix.split_at_mut(x * lanes);
                    for ((dst, &previous), &value) in after[..lanes]
                        .iter_mut()
                        .zip(&before[(x - 1) * lanes..])
                        .zip(&src[x * lanes..(x + 1) * lanes])
                    {
                        *dst = combine(previous, value);
                    }
                }
                suffix[(end - 1) * lanes..end * lanes]
                    .copy_from_slice(&src[(end - 1) * lanes..end * lanes]);
                for x in (start..end - 1).rev() {
                    let (before, after) = suffix.split_at_mut((x + 1) * lanes);
                    for ((dst, &next), &value) in before[x * lanes..]
                        .iter_mut()
                        .zip(&after[..lanes])
                        .zip(&src[x * lanes..(x + 1) * lanes])
                    {
                        *dst = combine(next, value);
                    }
                }
            }
        }
        let left = (k / 2).min(n);
        let right = n.saturating_sub(k - k / 2 - 1).max(left);
        if left < right {
            let count = (right - left) * lanes;
            for ((dst, &a), &b) in out[left * lanes..right * lanes]
                .iter_mut()
                .zip(&suffix[..count])
                .zip(&prefix[(k - 1) * lanes..(k - 1) * lanes + count])
            {
                *dst = combine(a, b);
            }
        }
        let last_block = (n - 1) / k * k;
        for x in (0..left).chain(right..n) {
            let start = x.saturating_sub(k / 2);
            let end = x.saturating_add(k - k / 2 - 1).min(n - 1);
            let a = &suffix[start * lanes..(start + 1) * lanes];
            let b = &prefix[end * lanes..(end + 1) * lanes];
            let dst = &mut out[x * lanes..(x + 1) * lanes];
            if start == 0 {
                dst.copy_from_slice(b);
            } else if start >= last_block {
                dst.copy_from_slice(a);
            } else {
                for ((dst, &a), &b) in dst.iter_mut().zip(a).zip(b) {
                    *dst = combine(a, b);
                }
            }
        }
    }
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
    // Benchmarks favor shifted slices for small kernels; use block scans from the measured length 81.
    if kw >= 81 && !src.data.is_empty() {
        rect_morph_axis(
            &src.data,
            &mut horizontal.data,
            src.width,
            src.channels,
            kw,
            dilate,
        );
    } else {
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
    }
    let mut out = src.clone();
    out.data.fill(neutral);
    let stride = src.width * src.channels;
    if kh >= 81 && !src.data.is_empty() {
        rect_morph_axis(
            &horizontal.data,
            &mut out.data,
            src.height,
            stride,
            kh,
            dilate,
        );
    } else {
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
    let coefficients = |n| {
        gaussian_kernel(n, sigma)
            .into_iter()
            .map(|a| {
                if T::INTEGER {
                    (a * 256.).round_ties_even() / 256.
                } else {
                    a as f32 as f64
                }
            })
            .collect::<Vec<_>>()
    };
    let kx = coefficients(size.0);
    let ky = coefficients(size.1);
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

#[cfg(test)]
fn rect_morph_reference(src: &Image<u8>, kw: usize, kh: usize, dilate: bool) -> Image<u8> {
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

#[cfg(test)]
fn gaussian_blur_reference<T: Pixel>(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn next(seed: &mut u64) -> u32 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        (*seed >> 32) as u32
    }

    #[test]
    fn rectangle_matches_reference() {
        let mut seed = 20261106;
        for (w, h) in [(1, 1), (1, 19), (23, 1), (9, 7), (93, 17)] {
            for channels in [1, 3] {
                for pattern in 0..3 {
                    let data = (0..w * h * channels)
                        .map(|_| match pattern {
                            0 => next(&mut seed) as u8,
                            1 => 0,
                            _ => 255,
                        })
                        .collect();
                    let src = Image::new(w, h, channels, data).unwrap();
                    let sizes: Vec<_> = (1..=12).chain([17, 81, 82, 100]).collect();
                    for &kw in &sizes {
                        for &kh in &sizes {
                            for dilate in [false, true] {
                                assert_eq!(
                                    rect_morph(&src, kw, kh, dilate),
                                    rect_morph_reference(&src, kw, kh, dilate),
                                    "{w}x{h}x{channels}, {kw}x{kh}, {dilate}"
                                );
                            }
                        }
                        let kh = 14usize.saturating_sub(kw).max(1);
                        let kernel = rect_kernel(kw, kh).unwrap();
                        for op in [Morphology::Open, Morphology::TopHat, Morphology::BlackHat] {
                            let black = matches!(op, Morphology::BlackHat);
                            let mut expected = rect_morph_reference(
                                &rect_morph_reference(&src, kw, kh, black),
                                kw,
                                kh,
                                !black,
                            );
                            if !matches!(op, Morphology::Open) {
                                for (value, &original) in expected.data.iter_mut().zip(&src.data) {
                                    *value = if black {
                                        value.saturating_sub(original)
                                    } else {
                                        original.saturating_sub(*value)
                                    };
                                }
                            }
                            assert_eq!(morphology(&src, &kernel, op), expected);
                        }
                        let mut expected = src.clone();
                        for iterations in 0..=3 {
                            assert_eq!(dilate(&src, &kernel, iterations), expected);
                            expected = rect_morph_reference(&expected, kw, kh, true);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn gaussian_matches_reference_bits() {
        let mut seed = 20261106;
        for (w, h) in [(1, 1), (1, 9), (11, 1), (13, 7)] {
            for channels in [1, 3] {
                let bytes = Image::new(
                    w,
                    h,
                    channels,
                    (0..w * h * channels)
                        .map(|_| next(&mut seed) as u8)
                        .collect(),
                )
                .unwrap();
                let mut floats = bytes.float();
                for (i, value) in floats.data.iter_mut().enumerate() {
                    *value = match i % 17 {
                        0 => -0.,
                        1 => f32::INFINITY,
                        2 => f32::NEG_INFINITY,
                        3 => f32::from_bits(0x7fc01234),
                        _ => f32::from_bits(next(&mut seed)),
                    };
                }
                for size in [(1, 1), (3, 3), (5, 7), (15, 3)] {
                    for sigma in [-1., 0.8, f64::INFINITY, f64::NAN] {
                        assert_eq!(
                            gaussian_blur(&bytes, size, sigma).unwrap(),
                            gaussian_blur_reference(&bytes, size, sigma).unwrap()
                        );
                        for image in [&bytes.float(), &floats] {
                            let actual = gaussian_blur(image, size, sigma).unwrap();
                            let expected = gaussian_blur_reference(image, size, sigma).unwrap();
                            assert_eq!(
                                actual.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                                expected
                                    .data
                                    .iter()
                                    .map(|v| v.to_bits())
                                    .collect::<Vec<_>>()
                            );
                        }
                    }
                }
            }
        }
    }
}
