use super::{Image, Pixel};
use anyhow::{ensure, Result};
pub fn match_template<T: Pixel>(
    src: &Image<T>,
    template: &Image<T>,
    mask: Option<&Image<u8>>,
) -> Result<Image<f32>> {
    ensure!(
        src.channels == template.channels
            && src.width >= template.width
            && src.height >= template.height,
        "Template dimensions exceed image"
    );
    if let Some(m) = mask {
        ensure!(
            m.width == template.width
                && m.height == template.height
                && (m.channels == 1 || m.channels == template.channels),
            "Invalid template mask"
        );
    }
    let width = src.width - template.width + 1;
    let height = src.height - template.height + 1;
    if mask.is_none()
        && src.channels == 1
        && src.data.iter().all(|v| v.float() == src.data[0].float())
    {
        let constant = template
            .data
            .iter()
            .all(|v| v.float() == template.data[0].float());
        return Image::new(
            width,
            height,
            1,
            vec![if constant { 1. } else { 0. }; width * height],
        );
    }
    if mask.is_none()
        && src
            .data
            .iter()
            .chain(&template.data)
            .all(|v| v.float().is_finite())
    {
        return cached_unmasked(src, template);
    }
    let source: Vec<_> = src.data.iter().map(|v| v.float() as f64).collect();
    // Keep raster order so sparse masked sums retain the reference accumulation order.
    let mut weights = vec![Vec::new(); src.channels];
    let mut stats = vec![(0., 0.); src.channels];
    for c in 0..src.channels {
        for ty in 0..template.height {
            for tx in 0..template.width {
                if mask.is_some_and(|m| {
                    m.data[(ty * m.width + tx) * m.channels + if m.channels == 1 { 0 } else { c }]
                        == 0
                }) {
                    continue;
                }
                let b = template.data[(ty * template.width + tx) * template.channels + c].float()
                    as f64;
                weights[c].push(((ty * src.width + tx) * src.channels + c, b));
                stats[c].0 += b;
                stats[c].1 += b * b;
            }
        }
    }
    let mut data = vec![0.; width * height];
    for y in 0..height {
        for x in 0..width {
            let (mut num, mut va, mut vb) = (0., 0., 0.);
            let base = (y * src.width + x) * src.channels;
            for (weights, &(sb, bb)) in weights.iter().zip(&stats) {
                let n = weights.len() as f64;
                let (mut sa, mut aa, mut ab) = (0., 0., 0.);
                for &(offset, b) in weights {
                    let a = source[base + offset];
                    sa += a;
                    aa += a * a;
                    ab += a * b;
                }
                num += ab - sa * sb / n;
                va += aa - sa * sa / n;
                vb += bb - sb * sb / n;
            }
            data[y * width + x] = if mask.is_none() && vb < f64::EPSILON {
                1.
            } else if mask.is_none() && (va <= 0. || va < 10. * f32::EPSILON as f64) {
                0.
            } else {
                (num / (va.max(0.) * vb.max(0.)).sqrt()) as f32
            };
        }
    }
    Image::new(width, height, 1, data)
}

struct CachedMatch {
    source: Image<f32>,
    template: Image<f32>,
    result: Image<f32>,
}
thread_local! {static MATCHES:std::cell::RefCell<std::collections::VecDeque<CachedMatch>>=const{std::cell::RefCell::new(std::collections::VecDeque::new())};}
fn cached_unmasked<T: Pixel>(src: &Image<T>, template: &Image<T>) -> Result<Image<f32>> {
    let width = src.width - template.width + 1;
    let height = src.height - template.height + 1;
    if src.channels != 1 || width * height * template.data.len() < 2_000_000 {
        return unmasked(src, template);
    }
    let convert = |im: &Image<T>| Image {
        width: im.width,
        height: im.height,
        channels: im.channels,
        data: im.data.iter().map(|v| v.float()).collect(),
    };
    let source = convert(src);
    let tpl = convert(template);
    MATCHES.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(i) = cache
            .iter()
            .position(|c| c.template == tpl && c.source == source)
        {
            let c = cache.remove(i).unwrap();
            let out = c.result.clone();
            cache.push_back(c);
            return Ok(out);
        }
        let result = unmasked(src, template)?;
        let bytes = (source.data.len() + tpl.data.len() + result.data.len()) * 4;
        while cache.len() >= 64
            || cache
                .iter()
                .map(|c| (c.source.data.len() + c.template.data.len() + c.result.data.len()) * 4)
                .sum::<usize>()
                + bytes
                > 32 * 1024 * 1024
        {
            if cache.pop_front().is_none() {
                break;
            }
        }
        cache.push_back(CachedMatch {
            source,
            template: tpl,
            result: result.clone(),
        });
        Ok(result)
    })
}

struct Moments {
    width: usize,
    height: usize,
    channels: usize,
    source: std::sync::Arc<Vec<f64>>,
    sums: Vec<f64>,
    squares: Vec<f64>,
}
thread_local! {static MOMENTS: std::cell::RefCell<Option<std::sync::Arc<Moments>>> = const { std::cell::RefCell::new(None) };}
fn moments<T: Pixel>(src: &Image<T>) -> std::sync::Arc<Moments> {
    MOMENTS.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(m) = cache.as_ref().filter(|m| {
            m.width == src.width
                && m.height == src.height
                && m.channels == src.channels
                && m.source
                    .iter()
                    .zip(&src.data)
                    .all(|(a, b)| *a == b.float() as f64)
        }) {
            return m.clone();
        }
        let channels = src.channels;
        let source: Vec<_> = src.data.iter().map(|v| v.float() as f64).collect();
        let stride = (src.width + 1) * channels;
        let mut sums = vec![0.; (src.height + 1) * stride];
        let mut squares = sums.clone();
        let mut row = vec![0.; channels];
        let mut row_square = row.clone();
        for y in 0..src.height {
            row.fill(0.);
            row_square.fill(0.);
            for x in 0..src.width {
                for c in 0..channels {
                    let v = source[(y * src.width + x) * channels + c];
                    row[c] += v;
                    row_square[c] += v * v;
                    let i = (y + 1) * stride + (x + 1) * channels + c;
                    sums[i] = sums[i - stride] + row[c];
                    squares[i] = squares[i - stride] + row_square[c];
                }
            }
        }

        let m = std::sync::Arc::new(Moments {
            width: src.width,
            height: src.height,
            channels,
            source: std::sync::Arc::new(source),
            sums,
            squares,
        });
        *cache = Some(m.clone());
        m
    })
}

fn unmasked<T: Pixel>(src: &Image<T>, template: &Image<T>) -> Result<Image<f32>> {
    let (width, height) = (
        src.width - template.width + 1,
        src.height - template.height + 1,
    );
    let channels = src.channels;
    let moments = moments(src);
    let (source, sums, squares) = (&moments.source, &moments.sums, &moments.squares);
    let stride = (src.width + 1) * channels;
    let n = (template.width * template.height) as f64;
    let mut weights = vec![vec![]; channels];
    let mut means = vec![0.; channels];
    let mut variance = 0.;
    for c in 0..channels {
        let (mut sum, mut square) = (0., 0.);
        for y in 0..template.height {
            for x in 0..template.width {
                let v = template.data[(y * template.width + x) * channels + c].float() as f64;
                sum += v;
                square += v * v;
                if v != 0. {
                    weights[c].push(((y * src.width + x) * channels + c, v));
                }
            }
        }
        means[c] = sum / n;
        variance += square - sum * sum / n;
    }
    if variance < f64::EPSILON {
        return Image::new(width, height, 1, vec![1.; width * height]);
    }
    let convolution = if channels == 1 && width * height * weights[0].len() > 2_000_000 {
        let tpl = std::sync::Arc::new(template.data.iter().map(|v| v.float() as f64).collect());
        Some(super::correlation::correlate(
            source,
            src.width,
            src.height,
            &tpl,
            template.width,
            template.height,
        ))
    } else {
        None
    };
    let mut data = vec![0.; width * height];
    // Window moments and template statistics are shared; only the dot product depends on each placement.
    for y in 0..height {
        for x in 0..width {
            let (mut num, mut va) = (0., 0.);
            let base = (y * src.width + x) * channels;
            for c in 0..channels {
                let tl = y * stride + x * channels + c;
                let tr = tl + template.width * channels;
                let bl = tl + template.height * stride;
                let br = bl + template.width * channels;
                let sum = sums[br] - sums[tr] - sums[bl] + sums[tl];
                let square = squares[br] - squares[tr] - squares[bl] + squares[tl];
                let dot = if let Some(values) = &convolution {
                    values[y * width + x]
                } else {
                    weights[c]
                        .iter()
                        .map(|&(i, v)| source[base + i] * v)
                        .sum::<f64>()
                };
                num += dot - sum * means[c];
                va += square - sum * sum / n;
            }
            data[y * width + x] = if va <= 0. || va < 10. * f32::EPSILON as f64 {
                0.
            } else {
                (num / (va.max(0.) * variance.max(0.)).sqrt()) as f32
            };
        }
    }
    Image::new(width, height, 1, data)
}
pub fn min_max_loc(src: &Image<f32>) -> (f64, f64, (i32, i32), (i32, i32)) {
    let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
    let (mut lp, mut hp) = ((-1, -1), (-1, -1));
    for (i, &v) in src.data.iter().enumerate() {
        if !v.is_nan() && (v < lo || lp.0 == -1) {
            lo = v;
            lp = ((i % src.width) as i32, (i / src.width) as i32);
        }
        if !v.is_nan() && (v > hi || hp.0 == -1) {
            hi = v;
            hp = ((i % src.width) as i32, (i / src.width) as i32);
        }
    }
    if lp.0 == -1 {
        (f64::NAN, f64::NAN, lp, hp)
    } else {
        (lo as f64, hi as f64, lp, hp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference<T: Pixel>(src: &Image<T>, tpl: &Image<T>, mask: Option<&Image<u8>>) -> Vec<f32> {
        let mut out = Vec::new();
        for y in 0..=src.height - tpl.height {
            for x in 0..=src.width - tpl.width {
                let (mut num, mut va, mut vb) = (0., 0., 0.);
                for c in 0..src.channels {
                    let mut n = 0.;
                    let (mut sa, mut sb, mut aa, mut bb, mut ab) = (0., 0., 0., 0., 0.);
                    for ty in 0..tpl.height {
                        for tx in 0..tpl.width {
                            if mask.is_some_and(|m| {
                                m.data[(ty * tpl.width + tx) * m.channels
                                    + if m.channels == 1 { 0 } else { c }]
                                    == 0
                            }) {
                                continue;
                            }
                            n += 1.;
                            let a = src.data[((y + ty) * src.width + x + tx) * src.channels + c]
                                .float() as f64;
                            let b =
                                tpl.data[(ty * tpl.width + tx) * tpl.channels + c].float() as f64;
                            sa += a;
                            sb += b;
                            aa += a * a;
                            bb += b * b;
                            ab += a * b;
                        }
                    }
                    num += ab - sa * sb / n;
                    va += aa - sa * sa / n;
                    vb += bb - sb * sb / n;
                }
                out.push(if mask.is_none() && vb < f64::EPSILON {
                    1.
                } else if mask.is_none() && va < 10. * f32::EPSILON as f64 {
                    0.
                } else {
                    (num / (va.max(0.) * vb.max(0.)).sqrt()) as f32
                });
            }
        }
        out
    }

    fn check<T: Pixel>(src: &Image<T>, tpl: &Image<T>, mask: Option<&Image<u8>>) {
        let actual = match_template(src, tpl, mask).unwrap();
        let expected = reference(src, tpl, mask);
        assert_eq!(actual.data.len(), expected.len());
        for (actual, expected) in actual.data.iter().zip(expected) {
            assert!(
                (actual.is_nan() && expected.is_nan())
                    || actual == &expected
                    || (actual - expected).abs() < 1e-6,
                "{actual} != {expected}"
            );
        }
    }

    #[test]
    fn match_template_matches_direct_random_inputs() {
        let mut seed = 71u32;
        for (sw, sh, tw, th, channels) in
            [(17, 13, 5, 3, 1), (129, 65, 27, 17, 1), (31, 19, 7, 5, 3)]
        {
            let mut random = |w, h| {
                Image::new(
                    w,
                    h,
                    channels,
                    (0..w * h * channels)
                        .map(|_| {
                            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                            (seed >> 24) as u8
                        })
                        .collect(),
                )
                .unwrap()
            };
            let src = random(sw, sh);
            let tpl = random(tw, th);
            check(&src, &tpl, None);
            let float = |im: &Image<u8>| {
                Image::new(
                    im.width,
                    im.height,
                    channels,
                    im.data.iter().map(|&v| v as f32 / 127. - 1.).collect(),
                )
                .unwrap()
            };
            check(&float(&src), &float(&tpl), None);
            for mask_channels in [1, channels] {
                let mask = Image::new(
                    tw,
                    th,
                    mask_channels,
                    (0..tw * th * mask_channels)
                        .map(|i| if i % 3 == 0 { 0 } else { 255 })
                        .collect(),
                )
                .unwrap();
                check(&src, &tpl, Some(&mask));
                check(&float(&src), &float(&tpl), Some(&mask));
            }
            let zero_mask = Image::new(tw, th, 1, vec![0; tw * th]).unwrap();
            check(&src, &tpl, Some(&zero_mask));
            let constant = Image::new(tw, th, channels, vec![7u8; tw * th * channels]).unwrap();
            check(&src, &constant, None);
            let constant_src = Image::new(sw, sh, channels, vec![7u8; sw * sh * channels]).unwrap();
            check(&constant_src, &tpl, None);
        }
    }
}
