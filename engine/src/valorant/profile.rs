use crate::{
    cv::{self, Image, Interpolation},
    layout::{Layout, Rect},
    profile::Profile,
};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
pub const BANNER_REF: Rect = [1316, 84, 600, 256];
pub const SPEC_REF: Rect = [740, 20, 460, 64];
fn source_x(x: f64, right: bool, aspect: f64, letterbox: bool) -> f64 {
    if letterbox {
        if right {
            (1920. + 1080. * aspect) / 2. - (1920. - x)
        } else {
            x
        }
    } else if right {
        1920. - (1920. - x) * (16. / 9.) / aspect
    } else {
        960. + (x - 960.) * (16. / 9.) / aspect
    }
}
pub fn capture_rect(rect: Rect, right: bool) -> Rect {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for (_, a) in crate::layout::SUPPORTED_ASPECTS {
        for lb in [false, true] {
            lo = lo.min(source_x(rect[0] as f64, right, a, lb));
            hi = hi.max(source_x((rect[0] + rect[2]) as f64, right, a, lb));
        }
    }
    [
        lo.floor() as i32,
        rect[1],
        (hi.ceil() - lo.floor()) as i32,
        rect[3],
    ]
}
#[derive(Clone, Debug)]
pub struct ValorantProfile {
    pub templates_version: String,
    pub capture_banner: Rect,
    pub capture_spec: Rect,
    pub dir: PathBuf,
    pub layout: Layout,
}
impl ValorantProfile {
    pub fn with_layout(&self, layout: Layout) -> Self {
        Self {
            layout,
            ..self.clone()
        }
    }
    pub fn decoder_profile(&self) -> Profile {
        Profile {
            templates_version: self.templates_version.clone(),
            banner_roi: self.capture_banner,
            spec_roi: self.capture_spec,
            white: serde_json::Value::Null,
            red: serde_json::Value::Null,
            spectating: vec![],
            name_sig_threshold: 0.,
            dedupe_window: 0.,
            dir: self.dir.clone(),
            layout: Layout::default(),
            killfeed_roi: None,
        }
    }
    pub fn letterboxed(&self, banner: &Image<u8>) -> bool {
        if self.layout.identity() {
            return false;
        }
        let bar = ((1920. + 1920. * self.layout.squash) / 2.) as i32 + 4 - self.capture_banner[0];
        let region = crate::detect::crop(
            banner,
            bar,
            0,
            self.capture_banner[2] - 4,
            banner.height as i32,
        );
        !region.data.is_empty()
            && region.data.iter().map(|v| *v as f64).sum::<f64>() / (region.data.len() as f64) < 12.
            && region.data.iter().all(|&v| v < 40)
    }
    fn cut(
        &self,
        img: &Image<u8>,
        capture: Rect,
        rect: Rect,
        right: bool,
        lb: bool,
    ) -> Result<Image<u8>> {
        let aspect = self.layout.squash * (16. / 9.);
        let a = source_x(rect[0] as f64, right, aspect, lb).round_ties_even() as i32 - capture[0];
        let b = source_x((rect[0] + rect[2]) as f64, right, aspect, lb).round_ties_even() as i32
            - capture[0];
        if a < 0 || b > img.width as i32 {
            bail!("Capture rect {capture:?} does not contain {rect:?} at aspect {aspect:.3}");
        }
        let part = img.crop(a as usize, 0, (b - a) as usize, img.height)?;
        if part.width == rect[2] as usize {
            Ok(part)
        } else {
            cv::resize(
                &part,
                rect[2] as usize,
                rect[3] as usize,
                Interpolation::Area,
            )
        }
    }
    pub fn restore(&self, banner: &Image<u8>, spec: &Image<u8>) -> Result<(Image<u8>, Image<u8>)> {
        let lb = self.letterboxed(banner);
        Ok((
            self.cut(banner, self.capture_banner, BANNER_REF, true, lb)?,
            self.cut(spec, self.capture_spec, SPEC_REF, false, lb)?,
        ))
    }
}
pub fn load_valorant_profile(dir: &Path) -> Result<ValorantProfile> {
    (|| {
    let pj = dir.join("profile.json");
    let text = std::fs::read_to_string(&pj)
        .map_err(|_| anyhow::anyhow!("profile.json does not exist: {}", pj.display()))?;
    let doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| anyhow::anyhow!("Invalid profile.json: {e}"))?;
    let version = doc["templates_version"].as_str().unwrap_or("");
    let banner: Rect = serde_json::from_value(doc["capture_rois"]["banner"].clone())?;
    let spec: Rect = serde_json::from_value(doc["capture_rois"]["spec"].clone())?;
    if version.is_empty() {
        bail!("profile.json has an invalid templates_version or capture_rois");
    }
    let want = (
        capture_rect(BANNER_REF, true),
        capture_rect(SPEC_REF, false),
    );
    if (banner, spec) != want {
        bail!("capture_rois {banner:?}/{spec:?} must be {:?}/{:?} (the reference rects at every aspect)",want.0,want.1);
    }
    Ok(ValorantProfile {
        templates_version: version.into(),
        capture_banner: banner,
        capture_spec: spec,
        dir: dir.into(),
        layout: Layout::default(),
    })
    })().map_err(|e:anyhow::Error|crate::errors::ValorantProfileError(e.to_string()).into())
}
