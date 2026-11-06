use super::Image;
use anyhow::{ensure, Result};
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Interpolation {
    Linear,
    Area,
}
pub trait Pixel: Copy + Default {
    const INTEGER: bool;
    fn float(self) -> f32;
    fn cast(v: f32) -> Self;
}
impl Pixel for u8 {
    const INTEGER: bool = true;
    fn float(self) -> f32 {
        self as f32
    }
    fn cast(v: f32) -> Self {
        v.round_ties_even().clamp(0., 255.) as u8
    }
}
impl Pixel for f32 {
    const INTEGER: bool = false;
    fn float(self) -> f32 {
        self
    }
    fn cast(v: f32) -> Self {
        v
    }
}
fn weights(
    src: usize,
    dst: usize,
    scale: f64,
    area: bool,
    decimate: bool,
    vertical: bool,
) -> Vec<Vec<(usize, f32)>> {
    (0..dst)
        .map(|d| {
            if decimate {
                let lo = d as f64 * scale;
                let hi = ((d + 1) as f64 * scale).min(src as f64);
                (lo.floor() as usize..hi.ceil() as usize)
                    .filter_map(|s| {
                        let w = (hi.min((s + 1) as f64) - lo.max(s as f64)) / (hi - lo);
                        ((hi.min((s + 1) as f64) - lo.max(s as f64)) > 1e-3)
                            .then_some((s.min(src - 1), w as f32))
                    })
                    .collect()
            } else {
                let f = (if area {
                    let s = (d as f64 * scale).floor();
                    (d + 1) as f64 - (s + 1.) / scale
                } else {
                    (d as f64 + 0.5) * scale - 0.5
                }) as f32;
                let base = if area {
                    (d as f64 * scale).floor()
                } else {
                    f.floor() as f64
                };
                let a = if area {
                    if f <= 0. {
                        0.
                    } else {
                        f - f.floor()
                    }
                } else {
                    f - base as f32
                };
                if vertical {
                    vec![
                        (base.clamp(0., src as f64 - 1.) as usize, 1. - a),
                        ((base + 1.).clamp(0., src as f64 - 1.) as usize, a),
                    ]
                } else if base < 0. {
                    vec![(0, 1.), (0, 0.)]
                } else if base >= src as f64 - 1. {
                    vec![(src - 1, 1.), (src - 1, 0.)]
                } else {
                    vec![(base as usize, 1. - a), (base as usize + 1, a)]
                }
            }
        })
        .collect()
}
pub fn resize<T: Pixel>(
    src: &Image<T>,
    width: usize,
    height: usize,
    method: Interpolation,
) -> Result<Image<T>> {
    resize_scale(
        src,
        width,
        height,
        src.width as f64 / width as f64,
        src.height as f64 / height as f64,
        method,
    )
}
pub fn resize_factor<T: Pixel>(
    src: &Image<T>,
    fx: f64,
    fy: f64,
    method: Interpolation,
) -> Result<Image<T>> {
    ensure!(
        fx.is_finite() && fy.is_finite() && fx > 0. && fy > 0.,
        "Invalid scale"
    );
    resize_scale(
        src,
        (src.width as f64 * fx).round_ties_even() as usize,
        (src.height as f64 * fy).round_ties_even() as usize,
        1. / fx,
        1. / fy,
        method,
    )
}
fn resize_scale<T: Pixel>(
    src: &Image<T>,
    width: usize,
    height: usize,
    sx: f64,
    sy: f64,
    method: Interpolation,
) -> Result<Image<T>> {
    ensure!(width > 0 && height > 0, "Invalid resize dimensions");
    if width == src.width && height == src.height {
        return Ok(src.clone());
    }
    let count = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(src.channels))
        .ok_or_else(|| anyhow::anyhow!("Invalid resize dimensions"))?;
    let mut data = Vec::new();
    data.try_reserve_exact(count)?;
    data.resize(count, T::default());
    let area = method == Interpolation::Area || (sx == 2. && sy == 2.);
    let decimate = area && sx >= 1. && sy >= 1.;
    let integer_area = decimate && sx == sx.floor() && sy == sy.floor();
    let wx = weights(src.width, width, sx, area, decimate, false);
    let wy = weights(src.height, height, sy, area, decimate, true);
    // Only non-decimating integer inputs benefit; keep the original path for area decimation and f32.
    if !decimate && T::INTEGER {
        let quantize = |weights: &[Vec<(usize, f32)>], stride: usize| {
            weights
                .iter()
                .map(|w| {
                    [0, 1].map(|i| (w[i].0 * stride, (w[i].1 * 2048.).round_ties_even() as i32))
                })
                .collect::<Vec<_>>()
        };
        let ax = quantize(&wx, src.channels);
        let ay = quantize(&wy, src.width * src.channels);
        for (y, by) in ay.iter().enumerate() {
            for (x, bx) in ax.iter().enumerate() {
                for c in 0..src.channels {
                    let mut rows = [0i32; 2];
                    for (j, &(iy, _)) in by.iter().enumerate() {
                        for &(ix, a) in bx {
                            rows[j] += src.data[iy + ix + c].float() as i32 * a;
                        }
                    }
                    // OpenCV's u8 vertical SIMD path drops four horizontal fractional bits.
                    let v = ((((by[0].1 * (rows[0] >> 4)) >> 16)
                        + ((by[1].1 * (rows[1] >> 4)) >> 16)
                        + 2)
                        >> 2) as f32;
                    data[(y * width + x) * src.channels + c] = T::cast(v);
                }
            }
        }
        return Image::new(width, height, src.channels, data);
    }
    for y in 0..height {
        for x in 0..width {
            for c in 0..src.channels {
                let v = if integer_area {
                    let mut sum = 0.;
                    for iy in y * sy as usize..((y + 1) * sy as usize).min(src.height) {
                        for ix in x * sx as usize..((x + 1) * sx as usize).min(src.width) {
                            sum += src.data[(iy * src.width + ix) * src.channels + c].float();
                        }
                    }
                    if T::INTEGER && sx == 2. && sy == 2. && src.channels != 2 {
                        (sum + 2.).floor() / 4.
                    } else {
                        sum * (1. / (sx * sy) as f32)
                    }
                } else {
                    let mut sum = 0f32;
                    for &(iy, b) in &wy[y] {
                        let mut row = 0f32;
                        for &(ix, a) in &wx[x] {
                            row += src.data[(iy * src.width + ix) * src.channels + c].float() * a;
                        }
                        sum += row * b;
                    }
                    sum
                };
                data[(y * width + x) * src.channels + c] =
                    if integer_area && T::INTEGER && sx == 2. && sy == 2. {
                        T::cast(v.floor())
                    } else {
                        T::cast(v)
                    };
            }
        }
    }
    Image::new(width, height, src.channels, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_matches_original_bits() {
        let mut seed = 0x1234_5678u32;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for case in 0..56 {
            let (w, h) = match case {
                0 => (1, 1),
                1 => (1, 9),
                2 => (11, 1),
                3 => (2, 2),
                4 => (7, 11),
                5 => (23, 17),
                _ => (1 + next() as usize % 31, 1 + next() as usize % 23),
            };
            for channels in 1..=4 {
                let bytes: Vec<_> = (0..w * h * channels)
                    .map(|i| match i % 7 {
                        0 => 0,
                        1 => 255,
                        2 => 127,
                        3 => 128,
                        _ => next() as u8,
                    })
                    .collect();
                let floats = bytes
                    .iter()
                    .enumerate()
                    .map(|(i, &v)| match i % 19 {
                        0 => -0.,
                        1 => f32::INFINITY,
                        2 => f32::NEG_INFINITY,
                        3 => f32::from_bits(0x7fc0_1234),
                        _ => (v as f32 - 128.) / 37.,
                    })
                    .collect();
                let src = Image::new(w, h, channels, bytes).unwrap();
                let float_src = Image::new(w, h, channels, floats).unwrap();
                for method in [Interpolation::Linear, Interpolation::Area] {
                    for (fx, fy) in [
                        (0.5, 0.5),
                        (0.75, 0.75),
                        (1.33, 1.33),
                        (2., 2.),
                        (0.7, 1.7),
                        (1., 1.),
                    ] {
                        let width = (w as f64 * fx).round_ties_even() as usize;
                        let height = (h as f64 * fy).round_ties_even() as usize;
                        for factor in [false, true] {
                            let (sx, sy) = if factor {
                                (1. / fx, 1. / fy)
                            } else {
                                (w as f64 / width as f64, h as f64 / height as f64)
                            };
                            let expected =
                                resize_scale_original(&src, width, height, sx, sy, method);
                            let actual = if factor {
                                resize_factor(&src, fx, fy, method)
                            } else {
                                resize(&src, width, height, method)
                            };
                            if width == 0 || height == 0 {
                                assert!(expected.is_err() && actual.is_err());
                                continue;
                            }
                            assert_eq!(
                                actual.unwrap(),
                                expected.unwrap(),
                                "{w}x{h} c={channels} {fx}x{fy} {method:?} factor={factor}"
                            );
                            let expected =
                                resize_scale_original(&float_src, width, height, sx, sy, method)
                                    .unwrap();
                            let actual = if factor {
                                resize_factor(&float_src, fx, fy, method)
                            } else {
                                resize(&float_src, width, height, method)
                            }
                            .unwrap();
                            assert_eq!(
                                actual.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                                expected
                                    .data
                                    .iter()
                                    .map(|v| v.to_bits())
                                    .collect::<Vec<_>>(),
                                "f32 {w}x{h} c={channels} {fx}x{fy} {method:?} factor={factor}"
                            );
                        }
                    }
                }
            }
        }
    }
    fn resize_scale_original<T: Pixel>(
        src: &Image<T>,
        width: usize,
        height: usize,
        sx: f64,
        sy: f64,
        method: Interpolation,
    ) -> Result<Image<T>> {
        ensure!(width > 0 && height > 0, "Invalid resize dimensions");
        if width == src.width && height == src.height {
            return Ok(src.clone());
        }
        let count = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(src.channels))
            .ok_or_else(|| anyhow::anyhow!("Invalid resize dimensions"))?;
        let mut data = Vec::new();
        data.try_reserve_exact(count)?;
        data.resize(count, T::default());
        let area = method == Interpolation::Area || (sx == 2. && sy == 2.);
        let decimate = area && sx >= 1. && sy >= 1.;
        let integer_area = decimate && sx == sx.floor() && sy == sy.floor();
        let wx = weights(src.width, width, sx, area, decimate, false);
        let wy = weights(src.height, height, sy, area, decimate, true);
        for y in 0..height {
            for x in 0..width {
                for c in 0..src.channels {
                    let v = if integer_area {
                        let mut sum = 0.;
                        for iy in y * sy as usize..((y + 1) * sy as usize).min(src.height) {
                            for ix in x * sx as usize..((x + 1) * sx as usize).min(src.width) {
                                sum += src.data[(iy * src.width + ix) * src.channels + c].float();
                            }
                        }
                        if T::INTEGER && sx == 2. && sy == 2. && src.channels != 2 {
                            (sum + 2.).floor() / 4.
                        } else {
                            sum * (1. / (sx * sy) as f32)
                        }
                    } else if !decimate && T::INTEGER {
                        let ax: Vec<i32> = wx[x]
                            .iter()
                            .map(|&(_, w)| (w * 2048.).round_ties_even() as i32)
                            .collect();
                        let ay: Vec<i32> = wy[y]
                            .iter()
                            .map(|&(_, w)| (w * 2048.).round_ties_even() as i32)
                            .collect();
                        let mut rows = [0i32; 2];
                        for (j, &(iy, _)) in wy[y].iter().enumerate() {
                            for (i, &(ix, _)) in wx[x].iter().enumerate() {
                                rows[j] += src.data[(iy * src.width + ix) * src.channels + c]
                                    .float() as i32
                                    * ax[i];
                            }
                        }
                        // OpenCV's u8 vertical SIMD path drops four horizontal fractional bits.
                        ((((ay[0] * (rows[0] >> 4)) >> 16) + ((ay[1] * (rows[1] >> 4)) >> 16) + 2)
                            >> 2) as f32
                    } else {
                        let mut sum = 0f32;
                        for &(iy, b) in &wy[y] {
                            let mut row = 0f32;
                            for &(ix, a) in &wx[x] {
                                row +=
                                    src.data[(iy * src.width + ix) * src.channels + c].float() * a;
                            }
                            sum += row * b;
                        }
                        sum
                    };
                    data[(y * width + x) * src.channels + c] =
                        if integer_area && T::INTEGER && sx == 2. && sy == 2. {
                            T::cast(v.floor())
                        } else {
                            T::cast(v)
                        };
                }
            }
        }
        Image::new(width, height, src.channels, data)
    }
}
