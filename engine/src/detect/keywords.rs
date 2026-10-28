use super::{crop, despeckle, ink_mask, match_best, red_mask, segments, white_mask};
use crate::{cv::Image, icon_detect::IconFrame, profile::Profile};
use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Keywords {
    pub assist: Option<Image<f32>>,
    pub knock: Option<Image<f32>>,
    pub assist_by_knock: bool,
}
const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | ((c.get(1).copied().unwrap_or(0) as u32) << 8)
            | c.get(2).copied().unwrap_or(0) as u32;
        for i in 0..4 {
            out.push(if i > c.len() {
                '='
            } else {
                TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char
            });
        }
    }
    out
}
fn decode(s: &str) -> Result<Vec<u8>> {
    let mut out = vec![];
    let mut n = 0u32;
    let mut bits = 0;
    let mut digits = 0;
    let mut pads = 0;
    for b in s.bytes() {
        if b == b'=' {
            pads += 1;
            continue;
        }
        ensure!(pads == 0, "Excess data after padding");
        let v = TABLE
            .iter()
            .position(|&v| v == b)
            .ok_or_else(|| anyhow::anyhow!("Only base64 data is allowed"))?;
        digits += 1;
        n = (n << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((n >> bits) as u8);
        }
    }
    ensure!(digits % 4 != 1, "Invalid base64-encoded string");
    ensure!(
        s.len().is_multiple_of(4) && pads <= 2 && digits % 4 == (4 - pads) % 4,
        "Incorrect padding"
    );
    Ok(out)
}
impl Keywords {
    pub fn empty(&self) -> bool {
        self.assist.is_none() && self.knock.is_none()
    }
    pub fn to_dict(&self) -> Value {
        let enc = |a: &Option<Image<f32>>| {
            a.as_ref().map_or(Value::Null,|a|json!({"shape":[a.height,a.width],"q8":encode(&a.data.iter().map(|v|(v*255.).round_ties_even().clamp(0.,255.) as u8).collect::<Vec<_>>())}))
        };
        json!({"assist":enc(&self.assist),"knock":enc(&self.knock),"assist_by_knock":self.assist_by_knock})
    }
    pub fn from_dict(v: Option<&Value>) -> Result<Self> {
        let dec = |e: Option<&Value>| -> Result<Option<Image<f32>>> {
            let Some(e) = e.filter(|v| !v.is_null() && **v != json!({}) && **v != json!(false))
            else {
                return Ok(None);
            };
            ensure!(e.is_object(), "Invalid keyword template format");
            let shape = e["shape"]
                .as_array()
                .filter(|s| s.len() == 2 && s.iter().all(|v| v.as_u64().is_some_and(|n| n > 0)))
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "Invalid keyword template shape: {}",
                        crate::profile::py_repr(&e["shape"])
                    )
                })?;
            let (h, w) = (
                shape[0].as_u64().unwrap() as usize,
                shape[1].as_u64().unwrap() as usize,
            );
            let raw = decode(e["q8"].as_str().unwrap_or(""))?;
            let count = h
                .checked_mul(w)
                .ok_or_else(|| anyhow::anyhow!("Keyword template data is too short"))?;
            ensure!(raw.len() >= count, "Keyword template data is too short");
            Ok(Some(Image::new(
                w,
                h,
                1,
                raw[..count].iter().map(|&v| v as f32 / 255.).collect(),
            )?))
        };
        if v.is_some_and(|v| !v.is_object() && !v.is_null()) {
            bail!("Invalid keyword template format");
        }
        Ok(Self {
            assist: dec(v.and_then(|v| v.get("assist")))?,
            knock: dec(v.and_then(|v| v.get("knock")))?,
            assist_by_knock: v
                .and_then(|v| v["assist_by_knock"].as_bool())
                .unwrap_or(false),
        })
    }
    pub fn scores_ink(&self, m: &Image<f32>, f: &IconFrame) -> Result<(f64, f64)> {
        let score = |t: &Option<Image<f32>>, x| -> Result<f64> {
            match t {
                None => Ok(-1.),
                Some(t) => Ok(match_best(&crop(m, x, 0, f.plus_x, m.height as i32), t)?.0),
            }
        };
        Ok((
            score(&self.assist, 0)?,
            score(&self.knock, 0.max(f.line_l - 4))?,
        ))
    }
    pub fn scores(&self, b: &Image<u8>, f: &IconFrame) -> Result<(f64, f64)> {
        self.scores_ink(&keyword_ink(b, f)?, f)
    }
}
pub fn row_ink(b: &Image<u8>, f: &IconFrame, pad: i32) -> Result<Image<f32>> {
    ink_mask(&crop(
        b,
        0,
        0.max(f.chev_y - pad),
        b.width as i32,
        f.chev_y + f.row_h + pad,
    ))
}
pub fn keyword_ink(b: &Image<u8>, f: &IconFrame) -> Result<Image<f32>> {
    let m = row_ink(b, f, 5)?;
    Ok(crop(&m, 0, 0, 0.max(f.plus_x), m.height as i32))
}
pub fn hand_strip(b: &Image<u8>, f: &IconFrame, hw: (usize, usize)) -> Result<Option<Image<f32>>> {
    let (h, w) = hw;
    let x = f.hand_x + w as i32 + 4;
    let b = crop(b, x, 0.max(f.hand_y - 2), x + 64, f.hand_y + h as i32 + 2);
    if b.width != 64 || b.height < h + 2 {
        Ok(None)
    } else {
        Ok(Some(ink_mask(&b)?))
    }
}
pub fn knock_strip(b: &Image<u8>, f: &IconFrame, p: &Profile) -> Result<Option<Image<f32>>> {
    let row = crop(
        b,
        f.line_l,
        0.max(f.chev_y - 2),
        f.line_l.max(f.plus_x - 3),
        f.chev_y + f.row_h + 2,
    );
    if row.data.is_empty() {
        return Ok(None);
    }
    let red = red_mask(&row, p, false);
    let mut ink = white_mask(&row, &p.white)?;
    for (v, &r) in ink.data.iter_mut().zip(&red.data) {
        *v = u8::from(*v != 0 || r != 0);
    }
    let ink = despeckle(&ink, 3)?;
    let segs = segments(
        &(0..row.width)
            .map(|x| {
                (0..row.height)
                    .any(|y| red.data[y * row.width + x] != 0 && ink.data[y * row.width + x] != 0)
            })
            .collect::<Vec<_>>(),
    );
    let Some(&(ns, _)) = segs.first().filter(|s| s.0 >= 42) else {
        return Ok(None);
    };
    Ok(Some(ink_mask(&crop(
        &row,
        ns as i32 - 42,
        0,
        ns as i32 - 6,
        row.height as i32,
    ))?))
}
pub fn consensus(strips: &[Image<f32>], banners: usize) -> Option<Image<f32>> {
    if banners < 3 || strips.is_empty() {
        return None;
    }
    let mut tpl = strips[0].clone();
    tpl.data.fill(0.);
    for s in strips {
        if s.width != tpl.width || s.height != tpl.height {
            return None;
        }
        for (a, b) in tpl.data.iter_mut().zip(&s.data) {
            *a += b;
        }
    }
    for v in &mut tpl.data {
        *v /= strips.len() as f32;
    }
    if (tpl.data.iter().filter(|&&v| v > 0.3).count() as f64) / tpl.data.len() as f64 >= 0.04 {
        Some(tpl)
    } else {
        None
    }
}
