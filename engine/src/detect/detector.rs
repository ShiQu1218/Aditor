use super::{crop, keyword_ink, match_best, read_name_sig, white_mask, Keywords};
use crate::{
    cv::{self, Image},
    icon_detect::{IconDetector, IconFrame, IconParams},
    mixtape::MixtapeDetector,
    models::{FrameResult, NameSig},
    profile::Profile,
};
use anyhow::Result;
#[cfg(test)]
#[path = "detector_tests.rs"]
mod tests;
#[derive(Clone, Debug)]
pub struct Pending {
    pub kind: String,
    pub f: IconFrame,
    pub ink: Image<f32>,
    pub sig: Option<NameSig>,
    pub spectating: bool,
}
#[derive(Clone, Debug)]
pub enum Prepared {
    Ready(FrameResult),
    Pending(Pending),
}
pub struct Detector {
    pub profile: Profile,
    pub icon_scale: f64,
    pub icons: IconDetector,
    pub keywords: Option<Keywords>,
    pub(crate) mixtape: MixtapeDetector,
    spec: Vec<(serde_json::Value, Image<u8>, f64)>,
}
fn empty(spectating: bool, hint: Option<&str>) -> FrameResult {
    FrameResult {
        kind: None,
        score: 0.,
        x: 0,
        damage_line: false,
        name_sig: None,
        spectating,
        hint: hint.map(str::to_owned),
    }
}
impl Detector {
    pub fn new(
        profile: &Profile,
        scale: f64,
        params: Option<IconParams>,
        keywords: Option<Keywords>,
    ) -> Result<Self> {
        let icons = IconDetector::new(&profile.dir, &[scale], params, false)?;
        let mixtape = MixtapeDetector::new(profile)?;
        let spec = profile
            .spectating
            .iter()
            .map(|s| {
                Ok((
                    s.white.clone(),
                    cv::read_png(&profile.dir.join(&s.file), true)?,
                    s.threshold,
                ))
            })
            .collect::<Result<_>>()?;
        let mut det = Self {
            profile: profile.clone(),
            icon_scale: scale,
            icons,
            keywords: None,
            mixtape,
            spec,
        };
        det.set_keywords(keywords);
        Ok(det)
    }
    pub fn set_keywords(&mut self, kw: Option<Keywords>) {
        self.keywords = kw.filter(|k| !k.empty());
    }
    pub(crate) fn spectating(&self, spec: &Image<u8>) -> Result<bool> {
        let sy = self.profile.spec_roi[1];
        let height = self.profile.spec_roi[3];
        let spec = if sy < 1028 && spec.height == height as usize {
            crop(
                spec,
                0,
                0.max(1028 - sy),
                spec.width as i32,
                0.max(1068 - sy),
            )
        } else {
            spec.clone()
        };
        if spec.data.is_empty() {
            return Ok(false);
        }
        for (white, tpl, thr) in &self.spec {
            let m = white_mask(&spec, white)?;
            let coords: Vec<_> = m
                .data
                .iter()
                .enumerate()
                .filter(|(_, v)| **v != 0)
                .map(|(i, _)| (i % m.width, i / m.width))
                .collect();
            if coords.is_empty() {
                continue;
            }
            let x0 = coords.iter().map(|p| p.0).min().unwrap().saturating_sub(8);
            let y0 = coords.iter().map(|p| p.1).min().unwrap().saturating_sub(8);
            let x1 = (coords.iter().map(|p| p.0).max().unwrap() + 9).min(m.width);
            let y1 = (coords.iter().map(|p| p.1).max().unwrap() + 9).min(m.height);
            if match_best(&crop(&m, x0 as i32, y0 as i32, x1 as i32, y1 as i32), tpl)?.0 >= *thr {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn knock_sig(&self, b: &Image<u8>, f: &IconFrame) -> Result<Option<NameSig>> {
        let x1 = if f.plus_x > f.line_l + 8 {
            f.plus_x - 3
        } else {
            f.chev_x - 4
        };
        read_name_sig(
            &crop(
                b,
                f.line_l,
                0.max(f.chev_y - 2),
                f.line_l.max(x1),
                f.chev_y + f.row_h + 2,
            ),
            &self.profile,
        )
    }
    pub fn prepare(&self, b: &Image<u8>, spec: &Image<u8>) -> Result<(Prepared, IconFrame)> {
        let spectating = self.spectating(spec)?;
        let f = self.icons.features(b)?;
        let r = match f.kind.as_deref() {
            Some(kind @ ("knock" | "assist_knock")) => Prepared::Pending(Pending {
                kind: kind.into(),
                f: f.clone(),
                ink: keyword_ink(b, &f)?,
                sig: if kind == "knock" {
                    self.knock_sig(b, &f)?
                } else {
                    None
                },
                spectating,
            }),
            Some("assist_elim") => Prepared::Ready(FrameResult {
                kind: f.kind.clone(),
                score: f.hand,
                x: f.hand_x,
                damage_line: false,
                name_sig: None,
                spectating,
                hint: None,
            }),
            Some("elim" | "squad_wipe" | "score_other") => Prepared::Ready(empty(spectating, None)),
            _ if f.chev >= self.icons.p.chev_min && f.plus >= self.icons.p.plus_min => {
                Prepared::Ready(empty(spectating, Some("cont")))
            }
            _ => Prepared::Ready(
                if let Some(plain) = self.mixtape.detect(b, spec)?.filter(|_| !spectating) {
                    plain
                } else {
                    empty(spectating, None)
                },
            ),
        };
        Ok((r, f))
    }
    pub fn resolve(&self, r: &Prepared) -> Result<FrameResult> {
        let Prepared::Pending(r) = r else {
            let Prepared::Ready(r) = r else {
                unreachable!()
            };
            return Ok(r.clone());
        };
        let mut kind = Some(r.kind.clone());
        if let Some(kw) = &self.keywords {
            let (a, k) = kw.scores_ink(&r.ink, &r.f)?;
            if a >= 0.7 {
                if r.f.name_color - r.f.name_color_bg < self.icons.p.name_color_min {
                    kind = Some("assist_knock".into());
                }
            } else if k < 0.7
                && if r.kind == "knock" {
                    kw.knock.is_some()
                } else {
                    kw.assist.is_some() || kw.assist_by_knock && kw.knock.is_some()
                }
            {
                kind = None;
            }
        }
        if kind.is_none() {
            return Ok(empty(r.spectating, None));
        }
        let sig = if kind.as_deref() == Some("knock") {
            r.sig.clone()
        } else {
            None
        };
        Ok(FrameResult {
            kind,
            score: r.f.chev,
            x: r.f.chev_x,
            damage_line: r.f.line2_ink - r.f.line2_ink_bg >= self.icons.p.line2_ink_min,
            name_sig: sig,
            spectating: r.spectating,
            hint: None,
        })
    }
    pub fn detect(&self, b: &Image<u8>, spec: &Image<u8>) -> Result<FrameResult> {
        self.resolve(&self.prepare(b, spec)?.0)
    }
}
