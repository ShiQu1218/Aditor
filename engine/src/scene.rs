use crate::{
    cv::{self, Image, Interpolation},
    layout::Layout,
};
use anyhow::{bail, Result};
use std::{collections::BTreeMap, path::Path};
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct SceneFrame {
    pub kind: &'static str,
    pub match_context: bool,
    pub scores: BTreeMap<String, f64>,
    pub blank: bool,
}
/// Minimum score for the mode card arrow shown by the opening screens.
const CHEVRON_MIN: f64 = 0.75;
impl SceneFrame {
    /// Mode card arrow without the loading footer: the map and legend select screens that come before loading.
    /// Summary screens belong to the previous match and never count.
    pub fn opening_hint(&self) -> bool {
        self.kind == "other"
            && !self.match_context
            && ["mode_chevron", "ranked_chevron"]
                .iter()
                .any(|k| self.scores.get(*k).is_some_and(|&v| v >= CHEVRON_MIN))
    }
    pub fn new(kind: &'static str) -> Self {
        Self {
            kind,
            match_context: false,
            scores: BTreeMap::new(),
            blank: false,
        }
    }
}
const TEMPLATES: [(&str, [usize; 4]); 14] = [
    ("mode_chevron", [95, 15, 160, 55]),
    ("ranked_chevron", [95, 15, 160, 55]),
    ("loading_footer", [237, 276, 166, 28]),
    ("wildcard_footer", [237, 157, 166, 28]),
    ("ready_border", [247, 297, 148, 55]),
    ("mode_border", [0, 268, 149, 85]),
    ("minimap_border", [7, 7, 103, 125]),
    ("health_border", [37, 313, 116, 39]),
    ("ranked_minimap", [7, 7, 103, 103]),
    ("spectator_minimap", [7, 27, 103, 103]),
    ("ranked_health", [33, 312, 120, 39]),
    ("spectator_health", [33, 291, 122, 39]),
    ("control_objectives", [287, 24, 44, 20]),
    ("summary_tabs", [196, 20, 250, 34]),
];
type SceneTemplate = (&'static str, [usize; 4], Image<u8>, Image<u8>);
pub struct SceneMatcher {
    templates: Vec<SceneTemplate>,
}
impl SceneMatcher {
    pub fn classify_frame(
        &self,
        frame: &Image<u8>,
        layout: Layout,
        full_scores: bool,
    ) -> Result<SceneFrame> {
        if frame.channels != 1 && frame.channels != 3 {
            bail!("Scene frame must have three BGR channels");
        }
        if frame.width < 640 || frame.height < 360 {
            bail!("Current scene settings require at least 640×360; provide a scene ROI or a larger full frame");
        }
        let gray = if frame.channels == 3 {
            cv::gray(frame)?
        } else {
            frame.clone()
        };
        let gray = cv::resize(&gray, 640, 360, Interpolation::Area)?;
        let image = layout.reference_thumb(&gray)?;
        let mut scores = if full_scores {
            self.scores(&image)?
        } else {
            BTreeMap::new()
        };
        let mut score = |name: &str| -> Result<f64> {
            if let Some(v) = scores.get(name) {
                return Ok(*v);
            }
            let v = self.match_score(&image, name)?;
            scores.insert(name.to_owned(), v);
            Ok(v)
        };
        let mut chevron = score("mode_chevron")?;
        if chevron < CHEVRON_MIN {
            chevron = score("ranked_chevron")?;
        }
        let mut kind = "other";
        if chevron >= CHEVRON_MIN {
            let mut footer = score("loading_footer")?;
            if footer < 0.75 {
                footer = score("wildcard_footer")?;
            }
            if footer >= 0.75 {
                kind = "pre_match";
            }
        }
        if kind == "other" && score("ready_border")? >= 0.7 && score("mode_border")? >= 0.7 {
            kind = "lobby";
        }
        if kind == "other" {
            let mut minimap = score("minimap_border")?;
            if minimap < 0.6 {
                minimap = score("ranked_minimap")?;
            }
            if minimap < 0.6 {
                minimap = score("spectator_minimap")?;
            }
            if minimap >= 0.6 || score("control_objectives")? >= 0.8 {
                let mut health = score("health_border")?;
                if health < 0.6 {
                    health = score("ranked_health")?;
                }
                if health < 0.6 {
                    health = score("spectator_health")?;
                }
                if health >= 0.6 {
                    kind = "in_match_hud";
                }
            }
        }
        let match_context = kind == "other" && score("summary_tabs")? >= 0.8;
        let blank = kind == "other" && gray.data.iter().all(|&v| v <= 8);
        Ok(SceneFrame {
            kind,
            match_context,
            scores,
            blank,
        })
    }
    pub fn new(scene_dir: Option<&Path>) -> Result<Self> {
        let default_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/scene");
        let dir = scene_dir.unwrap_or(&default_dir);
        let mut templates = vec![];
        for (name, roi) in TEMPLATES {
            let read = |suffix: &str| {
                let path = dir.join(format!("{name}{suffix}.png"));
                cv::read_png(&path, true).map_err(|_| {
                    anyhow::anyhow!("Could not read scene template: {}", path.display())
                })
            };
            templates.push((name, roi, read("")?, read("_mask")?));
        }
        Ok(Self { templates })
    }
    pub fn match_score(&self, image: &Image<u8>, key: &str) -> Result<f64> {
        let (_, [x, y, w, h], template, mask) = self
            .templates
            .iter()
            .find(|t| t.0 == key)
            .ok_or_else(|| anyhow::anyhow!("Unknown scene template: {key}"))?;
        let result = cv::match_template(&image.crop(*x, *y, *w, *h)?, template, Some(mask))?;
        Ok(result
            .data
            .iter()
            .filter(|s| s.is_finite())
            .copied()
            .reduce(f32::max)
            .unwrap_or(0.) as f64)
    }
    pub fn scores(&self, image: &Image<u8>) -> Result<BTreeMap<String, f64>> {
        self.templates
            .iter()
            .map(|t| Ok((t.0.to_owned(), self.match_score(image, t.0)?)))
            .collect()
    }
    pub fn classify(&self, image: &Image<u8>, layout: Layout) -> Result<&'static str> {
        Ok(self.classify_frame(image, layout, false)?.kind)
    }
}
