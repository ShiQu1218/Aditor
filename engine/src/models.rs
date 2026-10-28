use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

pub const COUNTING_TYPES: &[&str] = &["knock", "assist_knock", "assist_elim", "elim", "kill"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct VideoInfo {
    pub path: String,
    pub duration: f64,
    pub width: i32,
    pub height: i32,
    pub codec: String,
    pub start_time: f64,
    pub size: u64,
    pub mtime: f64,
    #[serde(default)]
    pub fps: f64,
    #[serde(default)]
    pub pix_fmt: String,
    #[serde(default)]
    pub game_aspect: Option<String>,
    #[serde(default)]
    pub game: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct NameSig {
    pub width: usize,
    pub bits: Vec<u8>,
}
impl NameSig {
    pub const HEIGHT: usize = 16;
    pub fn to_b64(&self) -> String {
        const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes: Vec<u8> = self
            .bits
            .chunks(8)
            .map(|chunk| {
                chunk
                    .iter()
                    .enumerate()
                    .fold(0, |v, (i, &b)| v | (u8::from(b != 0) << (7 - i)))
            })
            .collect();
        let mut out = format!("{}:", self.width);
        for chunk in bytes.chunks(3) {
            let n = ((chunk[0] as u32) << 16)
                | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
                | chunk.get(2).copied().unwrap_or(0) as u32;
            for i in 0..4 {
                out.push(if i > chunk.len() {
                    '='
                } else {
                    TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char
                });
            }
        }
        out
    }
    pub fn from_b64(text: &str) -> Result<Self> {
        let (w, s) = text
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("not enough values to unpack (expected 2, got 1)"))?;
        let width: usize = w.trim().parse()?;
        let length = width
            .checked_mul(Self::HEIGHT)
            .ok_or_else(|| anyhow::anyhow!("NameSig width overflow"))?;
        let mut bytes = Vec::new();
        let mut n = 0u32;
        let mut count = 0;
        let (mut digits, mut quad, mut pads) = (0, 0, 0);
        for b in s.bytes() {
            let v = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => {
                    if quad >= 2 {
                        pads += 1;
                        if quad + pads >= 4 {
                            quad = 0;
                            break;
                        }
                    }
                    continue;
                }
                _ => continue,
            };
            pads = 0;
            digits += 1;
            quad = (quad + 1) % 4;
            n = (n << 6) | v as u32;
            count += 6;
            if count >= 8 {
                count -= 8;
                bytes.push((n >> count) as u8);
            }
        }
        ensure!(quad!=1,"Invalid base64-encoded string: number of data characters ({digits}) cannot be 1 more than a multiple of 4");
        ensure!(quad == 0, "Incorrect padding");
        ensure!(
            bytes.len() * 8 >= length,
            "cannot reshape array into shape (16,{width})"
        );
        let bits = (0..length)
            .map(|i| (bytes[i / 8] >> (7 - i % 8)) & 1)
            .collect();
        Ok(Self { width, bits })
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct FrameResult {
    pub kind: Option<String>,
    pub score: f64,
    pub x: i32,
    pub damage_line: bool,
    pub name_sig: Option<NameSig>,
    pub spectating: bool,
    pub hint: Option<String>,
}
fn auto_source() -> String {
    "auto".into()
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub t: f64,
    #[serde(rename = "type")]
    pub kind: String,
    pub score: f64,
    pub damage_line: bool,
    pub name_sig: Option<serde_json::Value>,
    #[serde(default)]
    pub counted: bool,
    #[serde(default)]
    pub counted_reason: String,
    #[serde(default)]
    pub counted_override: Option<bool>,
    #[serde(default = "auto_source")]
    pub source: String,
    #[serde(default)]
    pub deleted: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpecInterval {
    pub start: f64,
    pub end: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Clip {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub origin: String,
    #[serde(default)]
    pub event_ids: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutoClipParams {
    pub gap: f64,
    pub n: i32,
    pub before: f64,
    pub after: f64,
    pub max_len: f64,
}
impl Default for AutoClipParams {
    fn default() -> Self {
        Self {
            gap: 20.,
            n: 3,
            before: 8.,
            after: 4.,
            max_len: 90.,
        }
    }
}
