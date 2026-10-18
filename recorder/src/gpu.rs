//! 共用的 D3D11 裝置。擷取、小圖裁切與硬體編碼都用同一個裝置，影格才能零複製傳遞。

use anyhow::{Context, Result};
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};

#[derive(Clone)]
pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
}

// SAFETY: 建立時已開啟 ID3D11Multithread 保護，immediate context 可跨執行緒使用。
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

impl Gpu {
    /// 在預設硬體轉接器上建立裝置（BGRA＋video 支援，並開啟 multithread 保護）。
    pub fn create() -> Result<Self> {
        let mut device = None;
        let mut context = None;
        // SAFETY: 標準 D3D11CreateDevice 呼叫；輸出參數由 windows crate 管理。
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .context("D3D11CreateDevice 失敗")?;
        }
        let device: ID3D11Device = device.context("D3D11CreateDevice 沒有回傳裝置")?;
        let context: ID3D11DeviceContext = context.context("D3D11CreateDevice 沒有回傳 context")?;
        let mt: ID3D11Multithread = context.cast().context("取得 ID3D11Multithread 失敗")?;
        // SAFETY: 純旗標設定。
        unsafe {
            let _ = mt.SetMultithreadProtected(true);
        }
        Ok(Self { device, context })
    }
}
