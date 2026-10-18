//! 小圖擷取（任務 B2）：在 GPU 上裁切 banner／spec ROI、縮出 320×180 灰階 thumb，
//! 以 4 fps 讀回 CPU（規格 §3.3）。
//!
//! 讀回必須非同步：本格 `CopySubresourceRegion` 到 staging，**下一次**取樣時才 `Map` 上一次的
//! staging（雙緩衝），避免 GPU 管線停頓。輸出尺寸固定為 ROI 在基準解析度下的寬高，
//! 實際畫面非 1920×1080 時在 GPU 縮放（與離線分析「先縮到 1920×1080 再裁」一致）。

use anyhow::{bail, Result};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

use crate::gpu::Gpu;
use crate::types::FramesSpec;

/// 一組讀回的小圖。banner／spec 為 BGR24（列緊密排列，無 padding）；thumb 為 GRAY8。
#[derive(Debug, Clone, PartialEq)]
pub struct SmallFrames {
    pub pts: i64,
    pub banner: Vec<u8>,
    pub spec: Vec<u8>,
    pub thumb: Option<Vec<u8>>,
}

pub struct SmallFrameExtractor {
    _private: (),
}

impl SmallFrameExtractor {
    pub fn new(_gpu: &Gpu, _frames: FramesSpec) -> Result<Self> {
        bail!("small frame extractor 尚未實作")
    }

    /// banner／spec 的輸出寬高（基準座標）。
    pub fn banner_size(&self) -> (u32, u32) {
        (0, 0)
    }

    pub fn spec_size(&self) -> (u32, u32) {
        (0, 0)
    }

    /// 每格擷取都呼叫；內部依 pts 節流到 `SMALL_FPS`。回傳「上一次取樣」已讀回的結果（若有）。
    pub fn on_frame(
        &mut self,
        _texture: &ID3D11Texture2D,
        _width: u32,
        _height: u32,
        _pts: i64,
    ) -> Option<SmallFrames> {
        None
    }
}
