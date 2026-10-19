//! Shared configuration types (matching IPC `start` command JSON; see spec §4.4).

use serde::{Deserialize, Serialize};

/// Rectangle in 1920×1080 reference coordinates (scaled proportionally by the capture backend).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    /// Construct from the IPC `[x, y, w, h]` array.
    pub fn from_array(a: [u32; 4]) -> Self {
        Self {
            x: a[0],
            y: a[1],
            w: a[2],
            h: a[3],
        }
    }

    /// Scale reference coordinates to the actual frame, clamp to its bounds, and keep dimensions at least 1.
    pub fn scaled(&self, base: (u32, u32), actual: (u32, u32)) -> Rect {
        let sx = actual.0 as f64 / base.0 as f64;
        let sy = actual.1 as f64 / base.1 as f64;
        let x = ((self.x as f64 * sx).round() as u32).min(actual.0.saturating_sub(1));
        let y = ((self.y as f64 * sy).round() as u32).min(actual.1.saturating_sub(1));
        let w = ((self.w as f64 * sx).round() as u32).clamp(1, actual.0 - x);
        let h = ((self.h as f64 * sy).round() as u32).clamp(1, actual.1 - y);
        Rect { x, y, w, h }
    }
}

/// Small-image specification supplied by Python from the profile; aditorrec does not parse profiles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FramesSpec {
    pub banner: [u32; 4],
    pub spec: [u32; 4],
    /// ROI reference resolution, currently fixed at `[1920, 1080]`.
    pub base: [u32; 2],
}

/// Fixed small-image output dimensions. banner/spec use the reference-resolution dimensions
/// so Python receives the same images as offline analysis (scale to 1920×1080, then crop).
pub const THUMB_W: u32 = 640;
pub const THUMB_H: u32 = 360;
/// Small-image sample rate (matching offline analysis `decode.FPS`).
pub const SMALL_FPS: u32 = 4;
/// Number of banners per thumbnail (4 fps / 4 = 1 fps).
pub const THUMB_EVERY: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    Hevc,
    H264,
    Av1,
}

/// Capture method: `wgc` = Windows Graphics Capture (window, default); `dda` = DXGI Desktop
/// Duplication (entire game display; lower latency without DWM window composition); `hook` = OBS
/// graphics-hook (inject into the game to intercept Present shared textures; bypass DWM and keep updating in the background unless minimized).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMethod {
    #[default]
    Wgc,
    Dda,
    Hook,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncodePreset {
    #[default]
    Speed,
    Balanced,
    Quality,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncodeAspect {
    #[default]
    Native,
    Fit,
    Stretch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderSource {
    #[default]
    Device,
    Game,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EncodeConfig {
    pub codec: Codec,
    /// `"auto"` or an explicit ffmpeg encoder name (for example, `"hevc_nvenc"`).
    pub encoder: String,
    pub fps: u32,
    /// Output height; 0 = native resolution. Width is proportional and rounded to an even number.
    pub height: u32,
    pub bitrate_kbps: u32,
    #[serde(default)]
    pub preset: EncodePreset,
    #[serde(default)]
    pub aspect: EncodeAspect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioConfig {
    /// `"default"` or a WASAPI device ID.
    pub render: String,
    pub capture: String,
    pub mic_gain: f32,
    pub mic_enabled: bool,
    #[serde(default = "enabled")]
    pub render_enabled: bool,
    #[serde(default = "unity", deserialize_with = "render_gain")]
    pub render_gain: f32,
    #[serde(default)]
    pub mic_mono: bool,
    #[serde(default)]
    pub render_source: RenderSource,
}

fn enabled() -> bool {
    true
}
fn unity() -> f32 {
    1.0
}
fn render_gain<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<f32, D::Error> {
    let gain = f32::deserialize(deserializer)?;
    if gain.is_finite() && (0.0..=2.0).contains(&gain) {
        Ok(gain)
    } else {
        Err(serde::de::Error::custom("System audio gain must be between 0 and 2"))
    }
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            render: "default".into(),
            capture: "default".into(),
            mic_gain: 1.0,
            mic_enabled: true,
            render_enabled: true,
            render_gain: 1.0,
            mic_mono: false,
            render_source: RenderSource::Device,
        }
    }
}

impl AudioConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.mic_gain.is_finite() && (0.0..=2.0).contains(&self.mic_gain),
            "Microphone gain must be between 0 and 2"
        );
        anyhow::ensure!(
            self.render_gain.is_finite() && (0.0..=2.0).contains(&self.render_gain),
            "System audio gain must be between 0 and 2"
        );
        Ok(())
    }
}

/// Fixed format after audio mixing.
pub const AUDIO_RATE: u32 = 48_000;
pub const AUDIO_CHANNELS: u32 = 2;

/// Segment duration in seconds; GOP duration matches and is forcibly aligned.
pub const SEGMENT_SECS: u32 = 2;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_scales_to_1440p() {
        let r = Rect {
            x: 100,
            y: 200,
            w: 300,
            h: 40,
        };
        assert_eq!(
            r.scaled((1920, 1080), (2560, 1440)),
            Rect {
                x: 133,
                y: 267,
                w: 400,
                h: 53
            }
        );
    }

    #[test]
    fn rect_is_clamped_inside_frame() {
        let r = Rect {
            x: 1900,
            y: 1070,
            w: 100,
            h: 100,
        };
        let s = r.scaled((1920, 1080), (1920, 1080));
        assert_eq!(
            s,
            Rect {
                x: 1900,
                y: 1070,
                w: 20,
                h: 10
            }
        );
    }
}
