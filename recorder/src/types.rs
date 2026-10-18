//! 各模組共用的設定型別（與 IPC `start` 指令的 JSON 對應，見規格 §4.4）。

use serde::{Deserialize, Serialize};

/// 1920×1080 基準座標中的矩形（實際解析度由擷取端等比換算）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    /// 由 IPC 的 `[x, y, w, h]` 陣列建立。
    pub fn from_array(a: [u32; 4]) -> Self {
        Self {
            x: a[0],
            y: a[1],
            w: a[2],
            h: a[3],
        }
    }

    /// 把基準座標換算到實際畫面尺寸；結果夾在畫面內，寬高至少 1。
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

/// 小圖規格：Python 端由 profile 讀出後傳入；apexrec 不解析 profile。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FramesSpec {
    pub banner: [u32; 4],
    pub spec: [u32; 4],
    /// ROI 的基準解析度，目前固定 `[1920, 1080]`。
    pub base: [u32; 2],
}

/// 小圖的固定輸出尺寸。banner／spec 輸出為「換算回基準解析度後」的大小，
/// 讓 Python 端拿到的圖與離線分析（縮放到 1920×1080 後再裁）一致。
pub const THUMB_W: u32 = 640;
pub const THUMB_H: u32 = 360;
/// 小圖取樣率（與離線分析 `decode.FPS` 相同）。
pub const SMALL_FPS: u32 = 4;
/// 每幾張 banner 帶一張 thumb（4 fps / 4 = 1 fps）。
pub const THUMB_EVERY: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    Hevc,
    H264,
    Av1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EncodeConfig {
    pub codec: Codec,
    /// `"auto"` 或明確的 ffmpeg 編碼器名稱（例如 `"hevc_nvenc"`）。
    pub encoder: String,
    pub fps: u32,
    /// 輸出高度；0 = 原生解析度。寬度依比例並取偶數。
    pub height: u32,
    pub bitrate_kbps: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioConfig {
    /// `"default"` 或 WASAPI 裝置 ID。
    pub render: String,
    pub capture: String,
    pub mic_gain: f32,
    pub mic_enabled: bool,
}

/// 音訊混音後的固定格式。
pub const AUDIO_RATE: u32 = 48_000;
pub const AUDIO_CHANNELS: u32 = 2;

/// 段落長度（秒）；GOP 與它相同並強制對齊。
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
