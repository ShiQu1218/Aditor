//! 硬體編碼＋fMP4 段落（任務 B1）。透過 `ffi`（預先產生的 ffmpeg 綁定）使用專案內建的
//! LGPL ffmpeg DLL：D3D11 hwframe → `*_nvenc`／`*_amf`／`*_qsv`；音訊 AAC；
//! 封裝為 `init.mp4` ＋ 每 2 秒一個 `seg_NNNNNN.m4s`（GOP 2 秒強制對齊，規格 §2.1）。
//!
//! 介面由骨架固定，實作者不得改動簽章。

pub mod ffi;

use std::path::Path;
use std::sync::mpsc::Sender;

use anyhow::{bail, Result};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

use crate::gpu::Gpu;
use crate::types::Codec;

#[derive(Debug, Clone, PartialEq)]
pub struct VideoParams {
    /// 輸出尺寸（偶數）。來源尺寸不同時在 GPU 縮放。
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Codec,
    /// `"auto"` 或明確編碼器名稱。
    pub encoder: String,
    pub bitrate_kbps: u32,
}

/// 一個段落寫完（已 flush＋fsync）後送出。
#[derive(Debug, Clone, PartialEq)]
pub struct SegmentInfo {
    pub seq: u64,
    pub pts_secs: f64,
    pub dur_secs: f64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EncodeStats {
    pub frames_in: u64,
    pub frames_encoded: u64,
    pub dropped: u64,
    pub queue_len: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushResult {
    Queued,
    /// 佇列滿，本格丟棄（計入 `dropped`）。
    Dropped,
}

pub struct SegmentWriter {
    _private: (),
}

impl SegmentWriter {
    /// 依序嘗試開啟各硬體編碼器（小尺寸試編一格），回傳可用者名稱，例如 `["hevc_nvenc","h264_nvenc"]`。
    pub fn probe_encoders(_gpu: &Gpu) -> Vec<String> {
        Vec::new()
    }

    /// 開啟編碼器與 muxer，寫出 `init.mp4`。`audio = true` 時建立 48 kHz 立體聲 AAC 軌。
    /// 沒有可用硬體編碼器時回傳錯誤（訊息含 `no_hw_encoder`）。
    pub fn open(
        _gpu: &Gpu,
        _dir: &Path,
        _video: VideoParams,
        _audio: bool,
        _on_segment: Sender<SegmentInfo>,
    ) -> Result<Self> {
        bail!("encode 尚未實作")
    }

    /// 實際使用的編碼器名稱。
    pub fn encoder_name(&self) -> &str {
        ""
    }

    /// 擷取執行緒呼叫：GPU 複製進內部 pool 後立即返回，不得阻塞。
    pub fn push_video(
        &self,
        _texture: &ID3D11Texture2D,
        _src_w: u32,
        _src_h: u32,
        _pts: i64,
    ) -> PushResult {
        PushResult::Dropped
    }

    /// 音訊執行緒呼叫：48 kHz 立體聲交錯 f32；`pts` 為第一個樣本的 tick。
    pub fn push_audio(&self, _interleaved: &[f32], _pts: i64) {}

    pub fn stats(&self) -> EncodeStats {
        EncodeStats::default()
    }

    /// flush 編碼器、寫出最後一段並關閉。
    pub fn finish(self) -> Result<()> {
        Ok(())
    }
}
