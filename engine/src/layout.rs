use crate::cv::{self, Image, Interpolation};
pub use crate::errors::LayoutError;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
pub type Rect = [i32; 4];
pub const SUPPORTED_ASPECTS: [(&str, f64); 4] = [
    ("16:9", 16. / 9.),
    ("16:10", 16. / 10.),
    ("4:3", 4. / 3.),
    ("5:4", 5. / 4.),
];
#[derive(Clone, Copy, Debug)]
pub enum Anchor {
    Top,
    Center,
    Bottom,
}
pub const BANNER_ANCHOR: Anchor = Anchor::Center;
pub const SPEC_ANCHOR: Anchor = Anchor::Bottom;
pub const SCENE_ROIS: [(Rect, Anchor); 8] = [
    ([285, 45, 480, 165], Anchor::Top),
    ([711, 828, 498, 84], Anchor::Bottom),
    ([711, 471, 498, 84], Anchor::Center),
    ([741, 891, 444, 165], Anchor::Bottom),
    ([0, 804, 447, 255], Anchor::Bottom),
    ([21, 21, 309, 375], Anchor::Top),
    ([99, 873, 366, 183], Anchor::Bottom),
    ([588, 60, 750, 102], Anchor::Top),
];
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub squash: f64,
}
impl Default for Layout {
    fn default() -> Self {
        Self { squash: 1. }
    }
}
impl Layout {
    pub fn from_ratio(ratio: f64) -> Self {
        Self {
            squash: ratio / (16. / 9.),
        }
    }
    pub fn identity(self) -> bool {
        self.squash == 1.
    }
    pub fn source_rect(self, rect: Rect, anchor: Anchor) -> [f64; 4] {
        let [x, y, w, h] = rect.map(f64::from);
        let k = self.squash;
        let top = match anchor {
            Anchor::Top => y * k,
            Anchor::Center => 540. + (y - 540.) * k,
            Anchor::Bottom => 1080. - (1080. - y) * k,
        };
        [x, top, w, h * k]
    }
    pub fn extract(
        self,
        img: &Image<u8>,
        capture: Rect,
        rect: Rect,
        anchor: Anchor,
    ) -> Result<Image<u8>> {
        let [_, sy, _, sh] = self.source_rect(rect, anchor);
        let top = sy.round_ties_even() - f64::from(capture[1]);
        let bottom = (sy + sh).round_ties_even() - f64::from(capture[1]);
        if !top.is_finite()
            || !bottom.is_finite()
            || top < 0.
            || bottom > img.height as f64
            || bottom <= top
        {
            return Err(LayoutError(format!(
                "Capture rect {} does not contain {} at squash {:?}",
                tuple(capture),
                tuple(rect),
                self.squash
            ))
            .into());
        }
        let x0 = (rect[0] - capture[0]).max(0) as usize;
        let part = img.crop(
            x0,
            top as usize,
            (rect[2] as usize).min(img.width.saturating_sub(x0)),
            (bottom - top) as usize,
        )?;
        if part.height == rect[3] as usize {
            Ok(part)
        } else {
            cv::resize(
                &part,
                rect[2] as usize,
                rect[3] as usize,
                Interpolation::Linear,
            )
        }
    }
    pub fn reference_thumb(self, thumb: &Image<u8>) -> Result<Image<u8>> {
        if self.identity() {
            return Ok(thumb.clone());
        }
        let mut out = thumb.clone();
        out.data.fill(0);
        for (rect, anchor) in SCENE_ROIS {
            let [x, y, w, h] = rect.map(|v| (v as f64 / 3.).round_ties_even() as usize);
            let [_, sy, _, sh] = self.source_rect(rect, anchor);
            let top = (sy / 3.).round_ties_even() as usize;
            let bottom = (((sy + sh) / 3.).round_ties_even() as usize).max(top + 1);
            let part = cv::resize(
                &thumb.crop(x, top, w, bottom - top)?,
                w,
                h,
                Interpolation::Linear,
            )?;
            for row in 0..h {
                let to = ((y + row) * out.width + x) * out.channels;
                let from = row * w * out.channels;
                out.data[to..to + w * out.channels]
                    .copy_from_slice(&part.data[from..from + w * out.channels]);
            }
        }
        Ok(out)
    }
}
fn tuple(r: Rect) -> String {
    format!("({}, {}, {}, {})", r[0], r[1], r[2], r[3])
}
pub fn capture_rect(rect: Rect, anchor: Anchor) -> Rect {
    let spans = SUPPORTED_ASPECTS.map(|(_, r)| Layout::from_ratio(r).source_rect(rect, anchor));
    let top = spans
        .iter()
        .map(|s| s[1])
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.) as i32;
    let bottom = spans
        .iter()
        .map(|s| s[1] + s[3])
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(1080.) as i32;
    [rect[0], top, rect[2], bottom - top]
}
pub fn parse_aspect(text: &str) -> Result<Layout> {
    (|| {
        let repr = crate::profile::py_repr(&serde_json::Value::String(text.into()));
        let parts: Vec<_> = text.trim().split([':', 'x', 'X', '×']).collect();
        if parts.len() != 2
            || parts
                .iter()
                .any(|s| s.trim().is_empty() || !s.trim().chars().all(|c| c.is_ascii_digit()))
        {
            bail!("Invalid aspect ratio: {repr}");
        }
        let w = parts[0].trim().parse::<f64>().unwrap_or(f64::INFINITY);
        let h = parts[1].trim().parse::<f64>().unwrap_or(f64::INFINITY);
        if w == 0. || h == 0. {
            bail!("Invalid aspect ratio: {repr}");
        }
        for (_, r) in SUPPORTED_ASPECTS {
            if ((w / h - r) / r).abs() <= 0.01 {
                return Ok(Layout::from_ratio(r));
            }
        }
        bail!("Unsupported aspect ratio: {repr}")
    })()
    .map_err(|error: anyhow::Error| anyhow::Error::new(LayoutError(error.to_string())))
}
pub fn tagged_layout(aspect: Option<&str>) -> Option<Layout> {
    parse_aspect(aspect.unwrap_or("")).ok()
}
pub fn recorded_layout(aspect: Option<&str>) -> Layout {
    tagged_layout(aspect).unwrap_or_default()
}
