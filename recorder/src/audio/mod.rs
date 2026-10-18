//! WASAPI 音訊（任務 B3）：系統聲音 loopback＋麥克風，各自轉成 48 kHz 立體聲 f32，
//! 依 QPC 對齊後混成一軌（規格 §2.4、R7）。
//!
//! 介面由骨架固定，實作者不得改動簽章。

pub mod mix;

use anyhow::{bail, Result};

use crate::protocol::AudioDevices;
use crate::types::AudioConfig;

/// 在音訊執行緒上被呼叫；不得阻塞。`interleaved` 為 48 kHz 立體聲 f32，`pts` 為第一個樣本的 tick。
pub trait AudioSink: Send {
    fn on_audio(&mut self, interleaved: &[f32], pts: i64);
}

pub fn list_devices() -> Result<AudioDevices> {
    bail!("audio 尚未實作")
}

pub struct AudioCapture {
    _private: (),
}

impl AudioCapture {
    /// `origin_ticks`：session 起點的 QPC tick；送出的 pts = 樣本 QPC − origin。
    pub fn start(
        _cfg: &AudioConfig,
        _origin_ticks: i64,
        _sink: Box<dyn AudioSink>,
    ) -> Result<Self> {
        bail!("audio 尚未實作")
    }

    pub fn stop(self) {}
}
