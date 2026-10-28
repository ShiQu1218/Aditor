pub use crate::errors::ProfileError;
use crate::{
    cv::Image,
    layout::{capture_rect, Anchor, Layout, Rect, BANNER_ANCHOR, SPEC_ANCHOR},
};
use anyhow::{bail, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};
pub const ICON_NAMES: [&str; 6] = ["chev", "person", "group", "skull", "hand", "plus"];
#[derive(Clone, Debug)]
pub struct SpecTemplate {
    pub file: String,
    pub threshold: f64,
    pub white: Value,
}
#[derive(Clone, Debug)]
pub struct Profile {
    pub templates_version: String,
    pub banner_roi: Rect,
    pub spec_roi: Rect,
    pub white: Value,
    pub red: Value,
    pub spectating: Vec<SpecTemplate>,
    pub name_sig_threshold: f64,
    pub dedupe_window: f64,
    pub dir: PathBuf,
    pub layout: Layout,
    pub killfeed_roi: Option<Rect>,
}
impl Profile {
    pub fn capture_banner(&self) -> Rect {
        capture_rect(self.banner_roi, BANNER_ANCHOR)
    }
    pub fn capture_spec(&self) -> Rect {
        capture_rect(self.spec_roi, SPEC_ANCHOR)
    }
    pub fn capture_killfeed(&self) -> Option<Rect> {
        self.killfeed_roi.map(|r| capture_rect(r, Anchor::Top))
    }
    pub fn with_layout(&self, layout: Layout) -> Self {
        Self {
            layout,
            ..self.clone()
        }
    }
    pub fn restore(&self, banner: &Image<u8>, spec: &Image<u8>) -> Result<(Image<u8>, Image<u8>)> {
        Ok((
            self.layout.extract(
                banner,
                self.capture_banner(),
                self.banner_roi,
                BANNER_ANCHOR,
            )?,
            self.layout
                .extract(spec, self.capture_spec(), self.spec_roi, SPEC_ANCHOR)?,
        ))
    }
    pub fn restore_killfeed(&self, img: &Image<u8>) -> Result<Image<u8>> {
        self.layout.extract(
            img,
            self.capture_killfeed()
                .ok_or_else(|| anyhow::anyhow!("No killfeed ROI"))?,
            self.killfeed_roi.unwrap(),
            Anchor::Top,
        )
    }
}
pub fn py_repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::String(s) => {
            let quote = if s.contains('\'') && !s.contains('"') {
                '"'
            } else {
                '\''
            };
            let mut r = String::new();
            r.push(quote);
            for c in s.chars() {
                match c {
                    '\n' => r.push_str("\\n"),
                    '\r' => r.push_str("\\r"),
                    '\t' => r.push_str("\\t"),
                    '\\' => r.push_str("\\\\"),
                    c if c == quote => {
                        r.push('\\');
                        r.push(c);
                    }
                    _ => r.push(c),
                }
            }
            r.push(quote);
            r
        }
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}: {}", py_repr(&Value::String(k.clone())), py_repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        _ => v.to_string(),
    }
}
fn num(v: &Value, name: &str, lo: f64, hi: f64, open: bool) -> Result<f64> {
    let Some(n) = v.as_f64() else {
        bail!("profile.json Field {name} must be a number: {}", py_repr(v));
    };
    if (if open { n <= lo } else { n < lo }) || n > hi {
        bail!("profile.json Field {name} is out of range: {}", py_repr(v));
    }
    Ok(n)
}
fn rect(v: &Value, name: &str) -> Result<Rect> {
    if let Some(a) = v.as_array().filter(|a| {
        a.len() == 4
            && a.iter()
                .all(|x| x.as_i64().is_some_and(|n| n >= 0 && n <= i32::MAX as i64))
    }) {
        return Ok([
            a[0].as_i64().unwrap() as i32,
            a[1].as_i64().unwrap() as i32,
            a[2].as_i64().unwrap() as i32,
            a[3].as_i64().unwrap() as i32,
        ]);
    }
    bail!(
        "profile.json Field {name} must contain 4 integers (≥0): {}",
        py_repr(v)
    )
}
fn white(v: &Value, name: &str) -> Result<Value> {
    if !v.is_object() {
        bail!("profile.json Field {name} must be an object");
    }
    for k in ["v_min", "s_max"] {
        num(&v[k], &format!("{name}.{k}"), 0., 255., false)?;
    }
    Ok(v.clone())
}
pub fn load_profile(dir: impl AsRef<Path>) -> Result<Profile> {
    (|| {

    let dir = dir.as_ref();
    let pj = dir.join("profile.json");
    if !pj.exists() {
        bail!("profile.json does not exist: {}", pj.display());
    }
    let text = std::fs::read_to_string(pj)?;
    let doc: Value =
        serde_json::from_str(&text).map_err(|e| anyhow::anyhow!("Invalid profile.json: {e}"))?;
    if !doc.is_object() {
        bail!("profile.json must be a JSON object");
    }
    for k in [
        "templates_version",
        "banner_roi",
        "spec_roi",
        "white",
        "red",
        "spectating",
        "name_sig_threshold",
        "dedupe_window",
    ] {
        if doc.get(k).is_none() {
            bail!("Missing field in profile.json: {k}");
        }
    }
    let Some(version) = doc["templates_version"].as_str().filter(|s| !s.is_empty()) else {
        bail!("profile.json Field templates_version must be a non-empty string");
    };
    let banner_roi = rect(&doc["banner_roi"], "banner_roi")?;
    let spec_roi = rect(&doc["spec_roi"], "spec_roi")?;
    let killfeed_roi = doc
        .get("killfeed_roi")
        .map(|v| rect(v, "killfeed_roi"))
        .transpose()?;
    if killfeed_roi.is_some_and(|[x, y, w, h]| {
        w <= 0 || h <= 0 || x as i64 + w as i64 > 1920 || y as i64 + h as i64 > 1080
    }) {
        bail!("profile.json killfeed_roi must fit within 1920×1080 and have positive dimensions");
    }
    if banner_roi[2] <= 0 || banner_roi[3] <= 0 || spec_roi[2] <= 0 || spec_roi[3] <= 0 {
        bail!("profile.json banner_roi/spec_roi width and height must be > 0");
    }
    for (name, [x, y, w, h]) in [("banner_roi", banner_roi), ("spec_roi", spec_roi)] {
        if x as i64 + w as i64 > 1920 || y as i64 + h as i64 > 1080 {
            bail!("profile.json {name} must fit within 1920×1080");
        }
    }
    let white = white(&doc["white"], "white")?;
    let red = &doc["red"];
    if !red.is_object() {
        bail!("profile.json Field red must be an object");
    }
    for k in ["r_min", "g_max", "b_max"] {
        num(&red[k], &format!("red.{k}"), 0., 255., false)?;
    }
    if let Some(v) = red.get("r_diff_min") {
        num(v, "red.r_diff_min", 0., 255., false)?;
    }
    for (sub, keys) in [
        ("yellow", ["r_min", "g_min", "b_max", "rb_min", "rg_max"]),
        ("pink", ["r_min", "g_min", "rg_min", "bg_min", "rb_min"]),
    ] {
        if let Some(rule) = red.get(sub) {
            if !rule.is_object() {
                bail!("profile.json Field red.{sub} must be an object");
            }
            for k in keys {
                num(&rule[k], &format!("red.{sub}.{k}"), -255., 255., false)?;
            }
        }
    }
    let Some(specs) = doc["spectating"].as_array() else {
        bail!("profile.json Field spectating must be an array");
    };
    let mut spectating = Vec::new();
    for (i, v) in specs.iter().enumerate() {
        let Some(file) = v["file"].as_str().filter(|s| !s.is_empty()) else {
            bail!("profile.json spectating[{i}] must have a string field named file");
        };
        if file.contains(['/', '\\'])
            || file == "."
            || file == ".."
            || Path::new(file).file_name().is_none_or(|n| n != file)
        {
            bail!("profile.json spectating[{i}].file must be a filename in the profile directory (no path allowed): {}",py_repr(&v["file"]));
        }
        let threshold = num(
            &v["threshold"],
            &format!("spectating[{i}].threshold"),
            0.,
            1.,
            true,
        )?;
        spectating.push(SpecTemplate {
            file: file.into(),
            threshold,
            white: self::white(
                v.get("white").unwrap_or(&white),
                &format!("spectating[{i}].white"),
            )?,
        });
    }
    let p = Profile {
        templates_version: version.into(),
        banner_roi,
        spec_roi,
        white,
        red: red.clone(),
        spectating,
        name_sig_threshold: num(
            &doc["name_sig_threshold"],
            "name_sig_threshold",
            0.,
            1.,
            true,
        )?,
        dedupe_window: num(
            &doc["dedupe_window"],
            "dedupe_window",
            0.,
            f64::INFINITY,
            true,
        )?,
        dir: dir.into(),
        layout: Layout::default(),
        killfeed_roi,
    };
    for file in p
        .spectating
        .iter()
        .map(|s| s.file.clone())
        .chain(ICON_NAMES.map(|n| format!("{n}.png")))
    {
        if !dir.join(&file).exists() {
            bail!("Template file is missing: {file}");
        }
    }
    Ok(p)

})().map_err(|error: anyhow::Error| anyhow::Error::new(ProfileError(error.to_string())))
}
