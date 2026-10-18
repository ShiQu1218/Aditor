//! WGC 擷取（任務 B2）。依 PID 找 Apex 的頂層視窗建立 `GraphicsCaptureItem`；
//! 視窗重建時自動重接；連續 3 秒全黑改用 `CreateForMonitor`（規格 §3.1）。
//!
//! 介面由骨架固定，實作者不得改動簽章；需要新增的型別放在本模組內。

pub mod small;

use std::sync::mpsc::Sender;

use anyhow::{bail, Result};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

use crate::gpu::Gpu;

/// 一格擷取畫面。`texture` 只在 `on_frame` 呼叫期間有效（屬於 WGC frame pool），
/// 消費者若要保留必須在呼叫內以 GPU 複製（`CopyResource`／`CopySubresourceRegion`）。
pub struct CapturedFrame<'a> {
    pub texture: &'a ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
    /// 100 ns tick，session 起點為 0（見 `clock`）。
    pub pts: i64,
}

/// 在擷取執行緒上被呼叫；**不得阻塞**（只做 GPU 複製與丟進佇列）。
pub trait FrameConsumer: Send {
    fn on_frame(&mut self, frame: &CapturedFrame<'_>);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureNotice {
    WindowLost,
    WindowFound {
        width: u32,
        height: u32,
        monitor: bool,
    },
}

#[derive(Debug, Clone)]
pub struct CaptureOptions {
    pub pid: u32,
    /// 送給消費者的最高 fps（超過就丟格，依 pts 節流）。
    pub max_fps: u32,
    /// 第一格的 QPC tick（`clock::now_ticks()`）；pts = 該格系統時間 − origin。
    pub origin_ticks: i64,
}

pub struct Capture {
    _private: (),
}

impl Capture {
    /// 開始擷取。找不到視窗時回傳錯誤（訊息含 `window_not_found`）。
    pub fn start(
        _gpu: &Gpu,
        _opts: CaptureOptions,
        _consumer: Box<dyn FrameConsumer>,
        _notices: Sender<CaptureNotice>,
    ) -> Result<Self> {
        bail!("capture 尚未實作")
    }

    /// 停止擷取並等待擷取執行緒結束。
    pub fn stop(self) {}
}
