use crate::{
    cv::{self, Image, Interpolation, Morphology},
    models::NameSig,
    profile::Profile,
};
use anyhow::Result;
use serde_json::Value;
mod keywords;
pub use keywords::*;
mod detector;
pub use detector::*;

pub(crate) fn crop<T: Clone>(im: &Image<T>, x0: i32, y0: i32, x1: i32, y1: i32) -> Image<T> {
    let x0 = x0.clamp(0, im.width as i32) as usize;
    let y0 = y0.clamp(0, im.height as i32) as usize;
    let x1 = (x1.clamp(0, im.width as i32) as usize).max(x0);
    let y1 = (y1.clamp(0, im.height as i32) as usize).max(y0);
    let data = (y0..y1)
        .flat_map(|y| {
            im.data[(y * im.width + x0) * im.channels..(y * im.width + x1) * im.channels]
                .iter()
                .cloned()
        })
        .collect();
    Image {
        width: x1 - x0,
        height: y1 - y0,
        channels: im.channels,
        data,
    }
}
fn mask(im: &Image<u8>, data: Vec<u8>) -> Image<u8> {
    Image {
        width: im.width,
        height: im.height,
        channels: 1,
        data,
    }
}
pub fn white_mask(im: &Image<u8>, white: &Value) -> Result<Image<u8>> {
    if im.data.is_empty() {
        return Ok(mask(im, vec![]));
    }
    let hsv = cv::hsv(im)?;
    let v_min = white["v_min"].as_f64().unwrap();
    let s_max = white["s_max"].as_f64().unwrap();
    Ok(mask(
        im,
        hsv.data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| {
                if p[2] as f64 >= v_min && p[1] as f64 <= s_max {
                    255
                } else {
                    0
                }
            })
            .collect(),
    ))
}
pub fn red_mask(im: &Image<u8>, profile: &Profile, pink: bool) -> Image<u8> {
    let rule = &profile.red;
    let n = |v: &Value, k: &str| v[k].as_f64().unwrap_or(0.);
    mask(
        im,
        im.data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| {
                let (b, g, r) = (p[0] as f64, p[1] as f64, p[2] as f64);
                let red = r >= n(rule, "r_min")
                    && g <= n(rule, "g_max")
                    && b <= n(rule, "b_max")
                    && rule
                        .get("r_diff_min")
                        .is_none_or(|v| r - g.max(b) >= v.as_f64().unwrap());
                let yellow = rule.get("yellow").is_some_and(|y| {
                    r >= n(y, "r_min")
                        && g >= n(y, "g_min")
                        && b <= n(y, "b_max")
                        && r - b >= n(y, "rb_min")
                        && (r - g).abs() <= n(y, "rg_max")
                });
                let pink = pink
                    && rule.get("pink").is_some_and(|p| {
                        r >= n(p, "r_min")
                            && g >= n(p, "g_min")
                            && r - g >= n(p, "rg_min")
                            && b - g >= n(p, "bg_min")
                            && r - b >= n(p, "rb_min")
                    });
                if red || yellow || pink {
                    255
                } else {
                    0
                }
            })
            .collect(),
    )
}
fn sig_image(sig: &NameSig) -> Image<f32> {
    Image {
        width: sig.width,
        height: 16,
        channels: 1,
        data: sig.bits.iter().map(|&v| v as f32).collect(),
    }
}
pub fn name_sig_similarity(a: &NameSig, b: &NameSig) -> f64 {
    if a.width == 0 || b.width == 0 {
        return 0.;
    }
    similarity(&sig_image(a), &sig_image(b))
}
pub fn similarity(a: &Image<f32>, b: &Image<f32>) -> f64 {
    let aa = a.clone();
    let mut bb = b.clone();
    if a.width != b.width {
        bb = cv::resize(&bb, a.width, a.height, Interpolation::Area).unwrap();
    }
    let mut aa = cv::gaussian_blur(&aa, (3, 3), 0.8).unwrap().data;
    let mut bb = cv::gaussian_blur(&bb, (3, 3), 0.8).unwrap().data;
    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
    let (ma, mb) = (mean(&aa), mean(&bb));
    for v in &mut aa {
        *v -= ma;
    }
    for v in &mut bb {
        *v -= mb;
    }
    let den =
        (aa.iter().map(|v| v * v).sum::<f32>() * bb.iter().map(|v| v * v).sum::<f32>()).sqrt();
    if den < 1e-6 {
        0.
    } else {
        (aa.iter().zip(bb).map(|(a, b)| a * b).sum::<f32>() / den) as f64
    }
}
pub fn same_name(a: Option<&NameSig>, b: Option<&NameSig>, threshold: f64) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    let max = a.width.max(b.width);
    max > 0
        && a.width.abs_diff(b.width) as f64 / (max as f64) < 0.15
        && name_sig_similarity(a, b) >= threshold
}
pub fn fragment_of(a: Option<&NameSig>, b: Option<&NameSig>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    let (s, l) = if a.width <= b.width { (a, b) } else { (b, a) };
    if s.width < 30 || (l.width - s.width) as f64 / (l.width as f64) < 0.15 {
        return false;
    }
    let mut s = cv::gaussian_blur(&sig_image(s), (3, 3), 0.8).unwrap();
    let l = cv::gaussian_blur(&sig_image(l), (3, 3), 0.8).unwrap();
    let mean = s.data.iter().sum::<f32>() / s.data.len() as f32;
    for v in &mut s.data {
        *v -= mean;
    }
    if s.data.iter().map(|v| v * v).sum::<f32>().sqrt() < 1e-6 {
        return false;
    }
    cv::match_template(&l, &s, None)
        .unwrap()
        .data
        .iter()
        .any(|v| v.is_finite() && *v >= 0.70)
}
pub fn segments(cols: &[bool]) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (i, &ink) in cols.iter().enumerate() {
        if ink {
            if let Some(last) = out.last_mut().filter(|r| r.1 + 1 == i) {
                last.1 = i;
            } else {
                out.push((i, i));
            }
        }
    }
    out
}
pub fn despeckle(ink: &Image<u8>, min_area: i32) -> Result<Image<u8>> {
    if ink.data.is_empty() {
        return Ok(ink.clone());
    }
    let mut out = ink.clone();
    for v in &mut out.data {
        *v = u8::from(*v != 0);
    }
    let thick = cv::morphology(&out, &cv::rect_kernel(5, 5)?, Morphology::Open);
    if thick.data.iter().any(|&v| v != 0) {
        let thick = cv::dilate(&thick, &cv::rect_kernel(3, 3)?, 2);
        for (v, t) in out.data.iter_mut().zip(thick.data) {
            *v &= !t;
        }
    }
    let cc = cv::connected_components(&out)?;
    let keep: Vec<_> = cc
        .stats
        .iter()
        .enumerate()
        .map(|(i, s)| {
            i > 0
                && s[4] >= min_area
                && !(s[3] <= 4 && s[2] >= 14
                    || s[2] >= 20 && (s[4] as f64) < 0.12 * (s[2] * s[3]) as f64)
        })
        .collect();
    out.data = cc
        .labels
        .data
        .iter()
        .map(|&i| u8::from(keep[i as usize]))
        .collect();
    Ok(out)
}
pub fn name_sig_from_row(
    row: &Image<u8>,
    profile: &Profile,
    pink: bool,
) -> Result<Option<NameSig>> {
    if row.data.is_empty() {
        return Ok(None);
    }
    let red = red_mask(row, profile, pink);
    let mut ink = white_mask(row, &profile.white)?;
    for (v, &r) in ink.data.iter_mut().zip(&red.data) {
        *v = u8::from(*v != 0 || r != 0);
    }
    let ink = despeckle(&ink, 3)?;
    let cols: Vec<_> = (0..row.width)
        .map(|x| {
            (0..row.height)
                .any(|y| red.data[y * row.width + x] != 0 && ink.data[y * row.width + x] != 0)
        })
        .collect();
    let segs = segments(&cols);
    let Some(&(start, mut end)) = segs.first() else {
        return Ok(None);
    };
    for &(a, b) in &segs[1..] {
        if a - end - 1 > 33 {
            break;
        }
        end = b;
    }
    if end - start + 1 < 4 {
        return Ok(None);
    }
    let block = crop(&ink, start as i32, 0, (end + 1) as i32, row.height as i32);
    let rows: Vec<_> = (0..block.height)
        .filter(|&y| {
            block.data[y * block.width..(y + 1) * block.width]
                .iter()
                .any(|&v| v != 0)
        })
        .collect();
    let block = crop(
        &block,
        0,
        rows[0] as i32,
        block.width as i32,
        (rows.last().unwrap() + 1) as i32,
    );
    let width = (block.width as f64 * 16. / block.height as f64)
        .round_ties_even()
        .max(1.) as usize;
    let small = cv::resize(&block.float(), width, 16, Interpolation::Area)?;
    Ok(Some(NameSig {
        width,
        bits: small.data.iter().map(|&v| u8::from(v >= 0.5)).collect(),
    }))
}
pub fn read_name_sig(row: &Image<u8>, profile: &Profile) -> Result<Option<NameSig>> {
    let sig = name_sig_from_row(row, profile, false)?;
    let density = |s: Option<&NameSig>| {
        s.map_or(0., |s| {
            s.bits.iter().map(|&v| v as f64).sum::<f64>() / s.bits.len() as f64
        })
    };
    if density(sig.as_ref()) < 0.12 && profile.red.get("pink").is_some() {
        let alt = name_sig_from_row(row, profile, true)?;
        if density(alt.as_ref()) >= 0.12 && density(alt.as_ref()) > density(sig.as_ref()) {
            return Ok(alt);
        }
    }
    Ok(sig)
}
pub fn name_strokes(im: &Image<u8>) -> Result<Image<f32>> {
    let k = cv::rect_kernel(7, 7)?;
    let light = cv::morphology(im, &k, Morphology::TopHat);
    let dark = cv::morphology(im, &k, Morphology::BlackHat);
    Ok(Image {
        width: im.width,
        height: im.height,
        channels: 1,
        data: light
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .zip(dark.data.as_chunks::<3>().0.iter())
            .map(|(a, b)| *a.iter().chain(b).max().unwrap() as f32)
            .collect(),
    })
}
pub fn ink_mask(im: &Image<u8>) -> Result<Image<f32>> {
    if im.data.is_empty() {
        return Ok(Image {
            width: im.width,
            height: im.height,
            channels: 1,
            data: vec![],
        });
    }
    let th = cv::morphology(&cv::gray(im)?, &cv::rect_kernel(7, 7)?, Morphology::TopHat);
    let mut out = th.float();
    for v in &mut out.data {
        *v = (*v / 100.).min(1.);
    }
    Ok(out)
}
pub fn match_best<T: cv::Pixel>(im: &Image<T>, tpl: &Image<T>) -> Result<(f64, i32, i32)> {
    if im.width < tpl.width || im.height < tpl.height {
        return Ok((0., 0, 0));
    }
    let r = cv::match_template(im, tpl, None)?;
    best_result(r)
}

pub(crate) fn best_result(r: Image<f32>) -> Result<(f64, i32, i32)> {
    let mut best = (f32::NEG_INFINITY, 0);
    for (i, &v) in r.data.iter().enumerate() {
        if v.is_finite() && v > best.0 {
            best = (v, i);
        }
    }
    if !best.0.is_finite() {
        Ok((0., 0, 0))
    } else {
        Ok((
            best.0 as f64,
            (best.1 % r.width) as i32,
            (best.1 / r.width) as i32,
        ))
    }
}
