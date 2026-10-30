use crate::{
    cv::{self, Image, Interpolation, Morphology},
    detect::{best_result, crop},
    profile::ICON_NAMES,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
pub const DEFAULT_SCALES: [f64; 5] = [0.9, 0.95, 1., 1.05, 1.1];
#[derive(Clone, Debug)]
pub struct IconParams {
    pub chev_min: f64,
    pub plus_min: f64,
    pub fig_min: f64,
    pub fig_lead: f64,
    pub left_min: f64,
    pub line2_icon_min: f64,
    pub line2_ink_min: f64,
    pub name_color_min: i32,
    pub left_above_max: f64,
}
impl Default for IconParams {
    fn default() -> Self {
        Self {
            chev_min: 0.75,
            plus_min: 0.70,
            fig_min: 0.60,
            fig_lead: 0.10,
            left_min: 0.85,
            line2_icon_min: 0.65,
            line2_ink_min: 0.05,
            name_color_min: 60,
            left_above_max: 0.70,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IconFrame {
    pub kind: Option<String>,
    pub chev: f64,
    pub chev_x: i32,
    pub chev_y: i32,
    pub chev_scale: f64,
    pub plus: f64,
    pub person: f64,
    pub group: f64,
    pub skull: f64,
    pub skull_x: i32,
    pub skull_y: i32,
    pub hand: f64,
    pub hand_x: i32,
    pub hand_y: i32,
    pub left_above: f64,
    pub line2_icons: i32,
    pub line2_ink: f64,
    pub name_color: i32,
    pub line2_ink_bg: f64,
    pub plus_x: i32,
    pub line_l: i32,
    pub row_h: i32,
    pub name_color_bg: i32,
}
impl Default for IconFrame {
    fn default() -> Self {
        Self {
            kind: None,
            chev: 0.,
            chev_x: 0,
            chev_y: 0,
            chev_scale: 1.,
            plus: 0.,
            person: 0.,
            group: 0.,
            skull: 0.,
            skull_x: 0,
            skull_y: 0,
            hand: 0.,
            hand_x: 0,
            hand_y: 0,
            left_above: 0.,
            line2_icons: 0,
            line2_ink: 0.,
            name_color: 0,
            line2_ink_bg: 0.,
            plus_x: 0,
            line_l: 0,
            row_h: 0,
            name_color_bg: 0,
        }
    }
}
pub fn enemy_color_mask(im: &Image<u8>) -> Image<u8> {
    Image {
        width: im.width,
        height: im.height,
        channels: 1,
        data: im
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| {
                let (b, g, r) = (p[0] as i32, p[1] as i32, p[2] as i32);
                u8::from(
                    r >= 185 && g <= 185 && b <= 185 && r - g.max(b) >= 50
                        || r >= 160 && g >= 150 && b <= 110 && r - b >= 90 && (r - g).abs() <= 30
                        || r >= 170 && g >= 100 && r - g >= 40 && b - g >= -12 && r - b >= 20,
                )
            })
            .collect(),
    }
}
pub fn is_knock(f: &IconFrame, p: &IconParams) -> bool {
    f.name_color - f.name_color_bg >= p.name_color_min
        || f.line2_ink - f.line2_ink_bg >= p.line2_ink_min
}
pub struct IconDetector {
    pub scales: Vec<f64>,
    pub p: IconParams,
    pub diag: bool,
    pub base: Vec<Image<u8>>,
    pub tpl: Vec<Vec<Image<u8>>>,
    prepared: Vec<Vec<cv::PreparedTemplate>>,
}
impl IconDetector {
    pub fn new(dir: &Path, scales: &[f64], params: Option<IconParams>, diag: bool) -> Result<Self> {
        anyhow::ensure!(!scales.is_empty(), "At least one icon scale is required");
        let base: Vec<_> = ICON_NAMES
            .iter()
            .map(|k| cv::read_png(&dir.join(format!("{k}.png")), true))
            .collect::<Result<_>>()?;
        let tpl: Vec<Vec<Image<u8>>> = base
            .iter()
            .map(|im| {
                scales
                    .iter()
                    .map(|&s| {
                        if (s - 1.).abs() < 1e-6 {
                            Ok(im.clone())
                        } else {
                            cv::resize_factor(
                                im,
                                s,
                                s,
                                if s < 1. {
                                    Interpolation::Area
                                } else {
                                    Interpolation::Linear
                                },
                            )
                        }
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .collect::<Result<_>>()?;
        let prepared = tpl
            .iter()
            .map(|scales| scales.iter().map(cv::PreparedTemplate::new).collect())
            .collect();
        Ok(Self {
            scales: scales.to_vec(),
            p: params.unwrap_or_default(),
            diag,
            base,
            tpl,
            prepared,
        })
    }
    fn best(&self, g: &Image<u8>, key: usize, near: Option<f64>) -> Result<(f64, i32, i32, usize)> {
        let first = self
            .scales
            .iter()
            .position(|s| near.is_none_or(|v| (s - v).abs() <= 0.051))
            .unwrap();
        let mut out = (0., 0, 0, first);
        for (i, &s) in self.scales.iter().enumerate() {
            if near.is_some_and(|v| (s - v).abs() > 0.051) {
                continue;
            }
            let t = &self.tpl[key][i];
            let (score, x, y) = if g.width < t.width || g.height < t.height {
                (0., 0, 0)
            } else {
                best_result(cv::match_prepared(g, t, &self.prepared[key][i])?)?
            };
            if score > out.0 {
                out = (score, x, y, i);
            }
        }
        Ok(out)
    }
    fn peaks(&self, g: &Image<u8>, key: usize, scale: usize, threshold: f64) -> Result<i32> {
        let t = &self.tpl[key][scale];
        if g.width < t.width || g.height < t.height {
            return Ok(0);
        }
        let r = cv::match_prepared(g, t, &self.prepared[key][scale])?;
        let (mut n, mut x) = (0, 0);
        while x < r.width {
            if (0..r.height).any(|y| {
                r.data[y * r.width + x].is_finite() && r.data[y * r.width + x] as f64 >= threshold
            }) {
                n += 1;
                x += t.width;
            } else {
                x += 1;
            }
        }
        Ok(n)
    }
    fn figure(&self, f: &IconFrame) -> Option<bool> {
        if f.person.max(f.group) >= self.p.fig_min && (f.person - f.group).abs() >= self.p.fig_lead
        {
            Some(f.person > f.group)
        } else {
            None
        }
    }
    fn score_gray(&self, g: &Image<u8>) -> Result<IconFrame> {
        let (cs, cx, cy, i) = self.best(g, 0, None)?;
        let sc = self.scales[i];
        let ch = &self.tpl[0][i];
        let mut f = IconFrame {
            chev: cs,
            chev_x: cx,
            chev_y: cy + 30,
            chev_scale: sc,
            ..IconFrame::default()
        };
        if cs >= self.p.chev_min {
            let px0 = 0.max(cx - (110. * sc) as i32);
            let sub = crop(
                g,
                px0,
                0.max(cy - 4),
                (px0 + 1).max(cx - (12. * sc) as i32),
                cy + ch.height as i32 + 4,
            );
            let (p, px, _, _) = self.best(&sub, 5, Some(sc))?;
            f.plus = p;
            f.plus_x = px0 + px;
            f.row_h = ch.height as i32;
        }
        Ok(f)
    }
    fn gray_band(banner: &Image<u8>) -> Result<Image<u8>> {
        cv::gray(&crop(banner, 0, 30, banner.width as i32, 150))
    }
    pub fn score_features(&self, banner: &Image<u8>) -> Result<IconFrame> {
        self.score_gray(&Self::gray_band(banner)?)
    }
    pub fn chev_best(&self, banner: &Image<u8>) -> Result<(f64, f64)> {
        let (score, _, _, s) = self.best(&Self::gray_band(banner)?, 0, None)?;
        Ok((score, self.scales[s]))
    }
    pub fn maybe_banner(&self, banner: &Image<u8>) -> Result<bool> {
        let g = Self::gray_band(banner)?;
        Ok(self.best(&g, 0, None)?.0 >= 0.6 || self.best(&g, 4, None)?.0 >= 0.85)
    }
    pub fn classify(&self, f: &IconFrame) -> Option<String> {
        let p = &self.p;
        let kind = if f.chev >= p.chev_min {
            if f.plus < p.plus_min {
                return None;
            }
            match self.figure(f) {
                Some(false) => {
                    if f.line2_icons >= 1 {
                        "squad_wipe"
                    } else {
                        "score_other"
                    }
                }
                Some(true) => {
                    if is_knock(f, p) {
                        "knock"
                    } else {
                        "assist_knock"
                    }
                }
                None => {
                    if f.line2_icons >= 1 {
                        "squad_wipe"
                    } else {
                        return None;
                    }
                }
            }
        } else if f.skull.max(f.hand) >= p.left_min && f.left_above < p.left_above_max {
            if f.skull >= f.hand {
                "elim"
            } else {
                "assist_elim"
            }
        } else {
            return None;
        };
        Some(kind.into())
    }
    pub fn features(&self, banner: &Image<u8>) -> Result<IconFrame> {
        let band = crop(banner, 0, 30, banner.width as i32, 150);
        let g = cv::gray(&band)?;
        let mut f = self.score_gray(&g)?;
        let (cs, cx, cy, sc) = (f.chev, f.chev_x, f.chev_y - 30, f.chev_scale);
        let si = self.scales.iter().position(|&s| s == sc).unwrap();
        let ch = &self.tpl[0][si];
        let h = ch.height as i32;
        if cs >= self.p.chev_min {
            let (x0, y0) = (cx + ch.width as i32 - 6, 0.max(cy - 8));
            let sub = crop(&g, x0, y0, x0 + (48. * sc) as i32, y0 + h + 16);
            f.person = self.best(&sub, 1, Some(sc))?.0;
            f.group = self.best(&sub, 2, Some(sc))?.0;
            let (l2y0, l2y1) = (
                cy + (0.75 * h as f64) as i32,
                (g.height as i32).min(cy + (2.1 * h as f64) as i32),
            );
            let l2 = crop(&g, 0, l2y0, g.width as i32, l2y1);
            if self.diag || f.plus >= self.p.plus_min && self.figure(&f) != Some(true) {
                f.line2_icons = self.peaks(&l2, 3, si, self.p.line2_icon_min)?
                    + self.peaks(&l2, 4, si, self.p.line2_icon_min)?;
            }
            let right = (g.width as i32).min(cx + ch.width as i32 + (24. * sc) as i32);
            let left = 0.max(g.width as i32 - right);
            f.line_l = left;
            let q = 20.max((right - left) / 4);
            let (xa, xb) = (0.max(400 - q), (g.width as i32).min(400 + q));
            f.line2_ink = stroke_ratio(&l2, xa, xb)?;
            let row = crop(&band, left, 0.max(cy - 2), left.max(cx - 4), cy + h + 2);
            f.name_color = color_count(&row);
            let ry1 = 0.max(cy + 30 - 4);
            let ry0 = 0.max(ry1 - h - 4);
            let reference = crop(banner, left, ry0, left.max(cx - 4), ry1);
            if !reference.data.is_empty() {
                f.name_color_bg = (color_count(&reference) as f64 * row.height as f64
                    / reference.height.max(1) as f64) as i32;
            }
            let rg = crop(
                banner,
                0,
                0.max(ry1 - (l2y1 - l2y0)),
                banner.width as i32,
                ry1,
            );
            if !rg.data.is_empty() {
                f.line2_ink_bg = stroke_ratio(&cv::gray(&rg)?, xa, xb)?;
            }
            if !self.diag {
                f.kind = self.classify(&f);
                return Ok(f);
            }
        }
        let (ss, sx, sy, sk) = self.best(&g, 3, None)?;
        let (hs, hx, hy, hd) = self.best(&g, 4, None)?;
        f.skull = ss;
        f.skull_x = sx;
        f.skull_y = sy + 30;
        f.hand = hs;
        f.hand_x = hx;
        f.hand_y = hy + 30;
        if ss.max(hs) >= self.p.left_min {
            let (lx, ly, i, key) = if ss >= hs {
                (sx, sy, sk, 3)
            } else {
                (hx, hy, hd, 4)
            };
            let t = &self.tpl[key][i];
            let h = t.height as i32;
            let w = t.width as i32;
            let row = crop(&band, lx + w, 0.max(ly - 2), lx + w + 320, ly + h + 2);
            if !(self.diag && cs >= self.p.chev_min) {
                f.name_color = color_count(&row);
            }
            let above = crop(
                &g,
                0.max(lx - 100),
                0.max(ly - 2 * h - 6),
                lx + 500,
                0.max(ly - 4),
            );
            if above.height >= self.tpl[0][0].height {
                f.left_above = self.best(&above, 0, None)?.0;
            }
        }
        f.kind = self.classify(&f);
        Ok(f)
    }
}
fn color_count(im: &Image<u8>) -> i32 {
    enemy_color_mask(im).data.iter().map(|&v| v as i32).sum()
}
fn stroke_ratio(g: &Image<u8>, xa: i32, xb: i32) -> Result<f64> {
    if g.data.is_empty() {
        return Ok(0.);
    }
    let th = cv::morphology(g, &cv::rect_kernel(7, 7)?, Morphology::TopHat);
    let th = crop(&th, xa, 0, xb, th.height as i32);
    Ok(if th.data.is_empty() {
        0.
    } else {
        th.data.iter().filter(|&&v| v >= 60).count() as f64 / th.data.len() as f64
    })
}
