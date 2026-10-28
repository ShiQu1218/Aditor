use super::ValorantProfile;
use crate::{
    cv::{self, Image, Interpolation, Morphology},
    detect::crop,
};
use anyhow::Result;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug)]
pub struct FeedRow {
    pub slot: usize,
    pub kind: String,
    pub signature: Vec<f32>,
    pub confirmed: bool,
    pub identity: Option<Vec<f32>>,
}
pub struct FeedDetector {
    cx: i32,
    cy: i32,
    right: i32,
}
fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    (v[(v.len() - 1) / 2] + v[v.len() / 2]) / 2.
}
fn normalized(mut v: Vec<f32>, center: bool) -> Vec<f32> {
    if center {
        let mean = v.iter().sum::<f32>() / v.len() as f32;
        for x in &mut v {
            *x -= mean;
        }
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt() + 1e-6;
    for x in &mut v {
        *x /= norm;
    }
    v
}
fn yellow(hsv: &Image<u8>, pale: bool) -> Image<u8> {
    Image {
        width: hsv.width,
        height: hsv.height,
        channels: 1,
        data: hsv
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| {
                u8::from(if pale {
                    p[0] >= 26 && p[0] <= 40 && p[1] >= 55 && p[2] >= 140
                } else {
                    p[0] >= 20 && p[0] <= 38 && p[1] >= 90 && p[2] >= 150
                }) * 255
            })
            .collect(),
    }
}
fn projecting(labels: &Image<i32>, id: i32, x: i32, y: i32, w: i32, h: i32, death: bool) -> bool {
    let boundary: Vec<f64> = (y..y + h)
        .map(|yy| {
            let points: Vec<_> = (0..w)
                .filter(|xx| labels.data[yy as usize * labels.width + (x + xx) as usize] == id)
                .collect();
            if points.is_empty() {
                w as f64
            } else if death {
                (w - 1 - points[points.len() - 1]) as f64
            } else {
                points[0] as f64
            }
        })
        .collect();
    let q = h as usize / 4;
    let wing = median(boundary[..q].to_vec()).min(median(
        boundary[(h as usize).saturating_sub((h as usize).div_ceil(4))..].to_vec(),
    ));
    wing - boundary[q..3 * h as usize / 4]
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min)
        >= 3.
}
impl FeedDetector {
    pub fn new(_: &ValorantProfile) -> Self {
        Self {
            cx: 1316,
            cy: 84,
            right: 1902 - 1316,
        }
    }
    pub fn band(&self, k: usize) -> (i32, i32) {
        let cy = 112 + 40 * k as i32 - self.cy;
        (cy - 15, cy + 15)
    }
    fn edge(&self, g: &Image<u8>, k: usize) -> f64 {
        let (b0, b1) = self.band(k);
        let (mut top, mut bottom) = (0f32, 0f32);
        for x in self.right - 140..self.right - 4 {
            let v = |y: i32| g.data[y as usize * g.width + x as usize] as f32;
            top += (v(b0 + 2) - v(b0 - 3)).abs();
            bottom += (v(b1 - 2) - v(b1 + 3)).abs();
        }
        ((top / 136.) + (bottom / 136.)) as f64
    }
    fn team(&self, hsv: &Image<u8>, k: usize) -> Option<&'static str> {
        let (b0, b1) = self.band(k);
        let r = crop(hsv, self.right - 130, b0 + 5, self.right - 60, b1 - 5);
        let (mut red, mut teal) = (0, 0);
        for p in r.data.as_chunks::<3>().0.iter() {
            if p[1] >= 55 && p[2] >= 110 {
                red += usize::from(p[0] <= 10 || p[0] >= 170);
                teal += usize::from((65..=100).contains(&p[0]));
            }
        }
        if red.max(teal) as f64 / ((r.width * r.height) as f64) < 0.30 {
            None
        } else {
            Some(if red > teal { "enemy" } else { "ally" })
        }
    }
    fn outline(&self, im: &Image<u8>, k: usize, x0: i32, x1: i32, death: bool) -> usize {
        let (b0, b1) = self.band(k);
        let (a, b) = if death {
            ((x0 - 170).max(0), (x0 - 2).max(0))
        } else {
            (x1 + 2, x1 + 170)
        };
        [(b0 - 6, b0 + 3), (b1 - 3, b1 + 5)]
            .iter()
            .map(|&(top, bot)| {
                let r = crop(im, a, top.max(0), b, bot);
                (0..r.width)
                    .filter(|&x| (0..r.height).any(|y| r.data[y * r.width + x] > 0))
                    .count()
            })
            .max()
            .unwrap_or(0)
    }
    fn boxes(&self, hsv: &Image<u8>, gray: &Image<u8>) -> Result<BTreeMap<usize, BTreeSet<bool>>> {
        let raw = yellow(hsv, false);
        let pale = yellow(hsv, true);
        let mut outline = raw.clone();
        for (a, b) in outline.data.iter_mut().zip(pale.data) {
            *a |= b;
        }
        let kernel = Image::new(3, 3, 1, vec![1; 9])?;
        let opened = cv::morphology(&raw, &kernel, Morphology::Open);
        let comp = cv::connected_components(&opened)?;
        let mut sides: BTreeMap<usize, BTreeSet<bool>> = BTreeMap::new();
        for (i, &[x, y, w, h, area]) in comp.stats.iter().enumerate().skip(1) {
            if !(18..=36).contains(&h) {
                continue;
            }
            let death = x + w >= self.right - 26;
            let (max_w, fill) = if death { (72, 0.18) } else { (60, 0.30) };
            if !(14..=max_w).contains(&w) || (area as f64) < fill * (w * h) as f64 {
                continue;
            }
            let k =
                ((y as f64 + h as f64 / 2. + self.cy as f64 - 112.) / 40.).round_ties_even() as i32;
            if !(0..6).contains(&k) {
                continue;
            }
            let k = k as usize;
            let (b0, b1) = self.band(k);
            if y < b0 - 4 || y + h > b1 + 4 || (!death && x > self.right - 200) {
                continue;
            }
            let cols = self.outline(&outline, k, x, x + w, death);
            if !death
                && (area as f64) < 0.45 * (w * h) as f64
                && self.outline(&raw, k, x, x + w, death) < 40
                && !projecting(&comp.labels, i as i32, x, y, w, h, death)
            {
                continue;
            }
            let outlined = cols >= 40;
            let edge = self.edge(gray, k);
            let compact =
                w >= 19 && cols >= 36 && area as f64 >= 0.60 * (w * h) as f64 && edge >= 45.;
            if edge < if outlined { 25. } else { 45. } {
                continue;
            }
            if h < 28 && (!(outlined || compact) || w < 19) {
                continue;
            }
            sides.entry(k).or_default().insert(death);
        }
        Ok(sides)
    }
    fn chevrons(
        &self,
        hsv: &Image<u8>,
        gray: &Image<u8>,
        faint: bool,
    ) -> Result<BTreeMap<usize, BTreeSet<bool>>> {
        let mask = yellow(hsv, faint);
        let comp = cv::connected_components(&mask)?;
        let mut sides: BTreeMap<usize, BTreeSet<bool>> = BTreeMap::new();
        for (i, &[x, y, w, h, area]) in comp.stats.iter().enumerate().skip(1) {
            let (mw, mh, fill) = if faint {
                (14, 26, 0.40)
            } else {
                (12, 22, 0.25)
            };
            if !(5..=mw).contains(&w)
                || !(14..=mh).contains(&h)
                || (h as f64) < 1.5 * w as f64
                || (area as f64) < fill * (w * h) as f64
            {
                continue;
            }
            let k =
                ((y as f64 + h as f64 / 2. + self.cy as f64 - 112.) / 40.).round_ties_even() as i32;
            if !(0..6).contains(&k) {
                continue;
            }
            let k = k as usize;
            let (b0, b1) = self.band(k);
            if y < b0 - 2 || y + h > b1 + 2 || self.edge(gray, k) < 25. {
                continue;
            }
            let death = x >= self.right - 4;
            if faint && !projecting(&comp.labels, i as i32, x, y, w, h, death) {
                continue;
            }
            if !death && x > self.right - 200 {
                continue;
            }
            let (a, b) = if death {
                ((x - 140).max(0), (x - 40).max(0))
            } else {
                (x + w + 40, x + w + 140)
            };
            let region = crop(hsv, a, b0 + 5, b, b1 - 5);
            if region.data.is_empty() {
                continue;
            }
            let share = region
                .data
                .as_chunks::<3>()
                .0
                .iter()
                .filter(|p| (55..=100).contains(&p[0]) && p[1] >= 25 && p[2] >= 110)
                .count() as f64
                / (region.width * region.height) as f64;
            if share < if faint { 0.15 } else { 0.30 } {
                continue;
            }
            if self.outline(&mask, k, x, x + w, death) >= 40 {
                sides.entry(k).or_default().insert(death);
            }
        }
        Ok(sides)
    }
    pub fn observations(&self, feed: &Image<u8>) -> Result<Vec<FeedRow>> {
        let hsv = cv::hsv(feed)?;
        let gray = cv::gray(feed)?;
        let mut marks = self.boxes(&hsv, &gray)?;
        for faint in [false, true] {
            for (k, s) in self.chevrons(&hsv, &gray, faint)? {
                marks.entry(k).or_default().extend(s);
            }
        }
        let mut out = vec![];
        for k in 0..6 {
            let sides = marks.get(&k).cloned().unwrap_or_default();
            let team = self.team(&hsv, k);
            let (kind, confirmed) = if team == Some("ally") && sides.contains(&true) {
                ("death", true)
            } else if team == Some("enemy") && sides == BTreeSet::from([false]) {
                ("kill", true)
            } else {
                if team.is_none() || self.edge(&gray, k) < 45. {
                    continue;
                }
                (
                    if team == Some("enemy") {
                        "kill"
                    } else {
                        "death"
                    },
                    false,
                )
            };
            let (b0, b1) = self.band(k);
            let g = crop(&gray, self.right - 200, b0 + 3, self.right - 4, b1 - 3).float();
            let signature = normalized(cv::resize(&g, 48, 6, Interpolation::Area)?.data, true);
            let r = crop(&hsv, self.right - 146, b0 + 5, self.right - 36, b1 - 5);
            let white = Image::new(
                r.width,
                r.height,
                1,
                r.data
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .map(|p| u8::from(p[1] <= 100 && p[2] >= 175) * 255)
                    .collect(),
            )?;
            let n = white.data.iter().filter(|&&v| v > 0).count();
            let identity = if n < 25 || n as f64 > white.data.len() as f64 * 0.6 {
                None
            } else {
                Some(normalized(
                    cv::resize(&white, 64, 12, Interpolation::Area)?
                        .float()
                        .data,
                    false,
                ))
            };
            out.push(FeedRow {
                slot: k,
                kind: kind.into(),
                signature,
                confirmed,
                identity,
            });
        }
        Ok(out)
    }
    pub fn rows(&self, feed: &Image<u8>) -> Result<Vec<FeedRow>> {
        Ok(self
            .observations(feed)?
            .into_iter()
            .filter(|r| r.confirmed)
            .collect())
    }
    pub fn origin(&self) -> (i32, i32) {
        (self.cx, self.cy)
    }
}
