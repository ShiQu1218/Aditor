use crate::{
    cv::{self, Image, Interpolation},
    detect::{crop, despeckle, ink_mask, name_strokes, red_mask, similarity, white_mask},
    models::{FrameResult, NameSig},
    profile::Profile,
};
use anyhow::Result;
pub fn text_match(ink: &Image<f32>, template: &Image<f32>) -> Result<(f64, i32, i32)> {
    TextMatcher::new(ink).best(template)
}
struct TextMatcher<'a> {
    ink: &'a Image<f32>,
    sums: Vec<f64>,
    squares: Vec<f64>,
}
impl<'a> TextMatcher<'a> {
    fn new(ink: &'a Image<f32>) -> Self {
        let stride = ink.width + 1;
        let mut sums = vec![0.; (ink.height + 1) * stride];
        let mut squares = sums.clone();
        for y in 0..ink.height {
            let (mut sum, mut square) = (0., 0.);
            for x in 0..ink.width {
                let v = ink.data[y * ink.width + x];
                sum += v as f64;
                square += (v * v) as f64;
                let i = (y + 1) * stride + x + 1;
                sums[i] = sums[i - stride] + sum;
                squares[i] = squares[i - stride] + square;
            }
        }
        Self { ink, sums, squares }
    }
    fn best(&self, template: &Image<f32>) -> Result<(f64, i32, i32)> {
        let ink = self.ink;
        if ink.width < template.width || ink.height < template.height {
            return Ok((0., 0, 0));
        }
        let mut r = cv::match_template(ink, template, None)?;
        let stride = ink.width + 1;
        let (sums, squares) = (&self.sums, &self.squares);
        let n = (template.width * template.height) as f64;
        for y in 0..r.height {
            for x in 0..r.width {
                let tl = y * stride + x;
                let tr = tl + template.width;
                let bl = tl + template.height * stride;
                let br = bl + template.width;
                let m = ((sums[br] - sums[tr] - sums[bl] + sums[tl]) / n) as f32;
                let square = ((squares[br] - squares[tr] - squares[bl] + squares[tl]) / n) as f32;
                let v = &mut r.data[y * r.width + x];
                if square - m * m < 0.01 || !v.is_finite() {
                    *v = 0.;
                }
            }
        }
        let mut best = (f32::NEG_INFINITY, 0);
        for (i, &v) in r.data.iter().enumerate() {
            if v > best.0 {
                best = (v, i);
            }
        }
        Ok((
            best.0 as f64,
            (best.1 % r.width) as i32,
            (best.1 / r.width) as i32,
        ))
    }
}
pub struct MixtapeDetector {
    profile: Profile,
    templates: Vec<(String, Image<f32>)>,
    pub(crate) speakers: Vec<Image<f32>>,
}
fn unit(im: &Image<u8>) -> Image<f32> {
    let mut out = im.float();
    for v in &mut out.data {
        *v /= 255.;
    }
    out
}
fn columns(im: &Image<u8>) -> Vec<usize> {
    (0..im.width)
        .filter(|&x| (0..im.height).any(|y| im.data[y * im.width + x] != 0))
        .collect()
}
fn rows(im: &Image<u8>) -> Vec<usize> {
    (0..im.height)
        .filter(|&y| {
            im.data[y * im.width..(y + 1) * im.width]
                .iter()
                .any(|&v| v != 0)
        })
        .collect()
}
impl MixtapeDetector {
    pub fn new(profile: &Profile) -> Result<Self> {
        let mut speakers = vec![];
        let mut templates = vec![];
        if let Ok(speaker) = cv::read_png(&profile.dir.join("mixtape_speaker.png"), true) {
            for s in [0.9, 1., 1.1] {
                speakers.push(unit(&cv::resize_factor(
                    &speaker,
                    s,
                    s,
                    Interpolation::Linear,
                )?));
            }
        }
        for (kind, name) in [
            ("kill", "mixtape_elim_zh"),
            ("assist_elim", "mixtape_assist_zh"),
            ("kill", "mixtape_elim_en"),
            ("assist_elim", "mixtape_assist_en"),
        ] {
            if let Ok(t) = cv::read_png(&profile.dir.join(format!("{name}.png")), true) {
                for s in [0.9, 0.95, 1., 1.05, 1.1] {
                    templates.push((
                        kind.into(),
                        unit(&cv::resize_factor(&t, s, s, Interpolation::Linear)?),
                    ));
                }
            }
        }
        Ok(Self {
            profile: profile.clone(),
            templates,
            speakers,
        })
    }
    pub fn detect(&self, banner: &Image<u8>, spec: &Image<u8>) -> Result<Option<FrameResult>> {
        let p = &self.profile;
        let [sx, sy, _, _] = p.spec_roi;
        if self.templates.is_empty() || sy > 962 || sy + (spec.height as i32) < 990 {
            return Ok(None);
        }
        let hud = crop(spec, 0.max(172 - sx), 962 - sy, 0.max(420 - sx), 990 - sy);
        if hud.data.is_empty() {
            return Ok(None);
        }
        let hud_mask = despeckle(&white_mask(&hud, &p.white)?, 3)?;
        if hud_mask.data.iter().filter(|&&v| v != 0).count() < 35 {
            return Ok(None);
        }
        let band = crop(banner, 0, 50, banner.width as i32, 110);
        let ink = ink_mask(&band)?;
        let mut best: Option<(f64, i32, i32, &str, &Image<f32>)> = None;
        let matcher = TextMatcher::new(&ink);
        for (kind, t) in &self.templates {
            let (score, x, y) = matcher.best(t)?;
            if score >= 0.80
                && best
                    .as_ref()
                    .is_none_or(|b| (kind == "assist_elim", score) > (b.3 == "assist_elim", b.0))
            {
                best = Some((score, x, y, kind, t));
            }
        }
        let Some((score, x, y, kind, tpl)) = best else {
            return Ok(None);
        };
        let uncertain = || {
            Some(FrameResult {
                kind: None,
                score: 0.,
                x: 0,
                damage_line: false,
                name_sig: None,
                spectating: false,
                hint: Some("plain_cont".into()),
            })
        };
        let row = crop(
            &band,
            x + tpl.width as i32,
            y,
            800.min(800 - x + 4),
            y + tpl.height as i32,
        );
        if row.data.is_empty() {
            return Ok(None);
        }
        let mut mask = if kind == "kill" {
            let mut m = red_mask(&row, p, true);
            let hsv = cv::hsv(&row)?;
            for (v, h) in m.data.iter_mut().zip(hsv.data.as_chunks::<3>().0.iter()) {
                if h[0] >= 15 && h[0] <= 40 && h[1] >= 90 && h[2] >= 120 {
                    *v = 255;
                }
            }
            m
        } else {
            let mut white = p.white.clone();
            white["v_min"] = 170.into();
            white_mask(&row, &white)?
        };
        let ink = ink_mask(&row)?;
        let mut strokes = mask.clone();
        for (v, &i) in strokes.data.iter_mut().zip(&ink.data) {
            *v = u8::from(*v != 0 && i >= 0.25);
        }
        strokes = despeckle(&strokes, 3)?;
        if strokes.data.iter().filter(|&&v| v != 0).count() < 35 {
            let names = name_strokes(&row)?;
            for (v, &i) in mask.data.iter_mut().zip(&names.data) {
                *v = u8::from(*v != 0 && i >= 25.);
            }
            strokes = despeckle(&mask, 3)?;
        }
        let cols = columns(&strokes);
        if cols.len() < 4 || cols[0] > 15 {
            return Ok(uncertain());
        }
        let (start, mut end) = (cols[0], cols.last().unwrap() + 1);
        for pair in cols.windows(2) {
            if pair[1] - pair[0] > 18 {
                let candidate = pair[0] + 1;
                if candidate - start >= 8
                    && ((2 * x + tpl.width as i32 + candidate as i32) as f64 / 2. - 400.).abs()
                        <= 4.
                {
                    end = candidate;
                    break;
                }
            }
        }
        if ((2 * x + tpl.width as i32 + end as i32) as f64 / 2. - 400.).abs() > 24. {
            return Ok(uncertain());
        }
        let glyph = crop(&strokes, start as i32, 0, end as i32, strokes.height as i32);
        let rs = rows(&glyph);
        if rs.is_empty() {
            return Ok(uncertain());
        }
        let (r0, r1) = (rs[0], rs.last().unwrap() + 1);
        let glyph = crop(&glyph, 0, r0 as i32, glyph.width as i32, r1 as i32);
        let (gh, gw) = (glyph.height, glyph.width);
        if gh < 9
            || gw < 8
            || glyph.data.iter().map(|&v| v as usize).sum::<usize>() as f64 / ((gh * gw) as f64)
                < 0.08
        {
            return Ok(uncertain());
        }
        let mut masks = vec![];
        for level in [200, 170, 140] {
            let mut white = p.white.clone();
            white["v_min"] = level.into();
            masks.push(despeckle(&white_mask(&hud, &white)?, 3)?);
        }
        let mut limit = hud.width;
        for hm in &masks {
            for speaker in &self.speakers {
                let (score, x, _) = text_match(&hm.float(), speaker)?;
                let tail = crop(
                    hm,
                    x + speaker.width as i32,
                    0,
                    hm.width as i32,
                    hm.height as i32,
                );
                if score >= 0.75 && tail.data.iter().all(|&v| v == 0) {
                    limit = limit.min(x as usize);
                }
            }
        }
        let vi = cv::resize(
            &crop(&ink, start as i32, r0 as i32, end as i32, r1 as i32),
            128,
            16,
            Interpolation::Linear,
        )?;
        let victim = cv::resize(&glyph.float(), 128, 16, Interpolation::Linear)?;
        let hud_ink = ink_mask(&hud)?;
        for hm in masks {
            let hm = crop(&hm, 0, 0, limit as i32, hm.height as i32);
            let hc = columns(&hm);
            if hc.is_empty() {
                continue;
            }
            let hstart = hc[0];
            let mut ends: Vec<_> = [-1, 0, 1, 2]
                .iter()
                .map(|d| (limit as i32).min(*hc.last().unwrap() as i32 + 1 + d))
                .collect();
            ends.sort();
            ends.dedup();
            for hend in ends {
                let block = crop(&hm, hstart as i32, 0, hend, hm.height as i32);
                let hr = rows(&block);
                if hr.is_empty() {
                    continue;
                }
                let (a, b) = (hr[0], hr.last().unwrap() + 1);
                let ratio =
                    (hend - hstart as i32) as f64 / (gw as f64 * (b - a) as f64 / gh as f64);
                if !(0.7..=1.3).contains(&ratio) {
                    continue;
                }
                let hi = cv::resize(
                    &crop(&hud_ink, hstart as i32, a as i32, hend, b as i32),
                    128,
                    16,
                    Interpolation::Linear,
                )?;
                let bits = cv::resize(
                    &crop(&hm, hstart as i32, a as i32, hend, b as i32).float(),
                    128,
                    16,
                    Interpolation::Linear,
                )?;
                if similarity(&bits, &victim) >= 0.62 {
                    return Ok(None);
                }
                if similarity(&crop(&hi, 0, 0, 50, 16), &crop(&vi, 0, 0, 50, 16)) >= 0.70
                    && similarity(&crop(&hi, 105, 0, 128, 16), &crop(&vi, 105, 0, 128, 16)) >= 0.70
                    && similarity(&hi, &vi) >= 0.45
                {
                    return Ok(None);
                }
            }
        }
        let event_glyph = crop(&strokes, start as i32, 0, end as i32, strokes.height as i32);
        let width = (gw as f64 * 16. / event_glyph.height as f64)
            .round_ties_even()
            .max(1.) as usize;
        let sig = NameSig {
            width,
            bits: cv::resize(&event_glyph.float(), width, 16, Interpolation::Linear)?
                .data
                .iter()
                .map(|&v| u8::from(v >= 0.5))
                .collect(),
        };
        Ok(Some(FrameResult {
            kind: Some(kind.into()),
            score,
            x,
            damage_line: false,
            name_sig: Some(sig),
            spectating: false,
            hint: Some("plain".into()),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_matcher_reuses_moments_for_different_templates() {
        let mut seed = 19u32;
        let ink = Image::new(
            37,
            21,
            1,
            (0..37 * 21)
                .map(|_| {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    (seed >> 24) as f32 / 255.
                })
                .collect(),
        )
        .unwrap();
        let matcher = TextMatcher::new(&ink);
        for (x, y, w, h) in [(11, 8, 7, 5), (22, 3, 9, 7)] {
            let template = ink.crop(x, y, w, h).unwrap();
            let (score, actual_x, actual_y) = matcher.best(&template).unwrap();
            assert!((score - 1.).abs() < 1e-6);
            assert_eq!((actual_x, actual_y), (x as i32, y as i32));
        }
    }

    #[test]
    fn flat_float_inputs_never_match_text() {
        let p = crate::profile::load_profile(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/icons"),
        )
        .unwrap();
        let detector = MixtapeDetector::new(&p).unwrap();
        for level in [0., 0.001, 0.5, 1.] {
            let ink = Image::new(800, 60, 1, vec![level; 800 * 60]).unwrap();
            for (_, template) in &detector.templates {
                assert_eq!(text_match(&ink, template).unwrap().0, 0.);
            }
        }
    }
}
