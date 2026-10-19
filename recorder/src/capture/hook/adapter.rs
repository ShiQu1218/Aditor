//! 共享材質的顯示卡選擇與開啟。
//!
//! OBS `graphics-hook` 使用舊式 DXGI 共享資源（`D3D11_RESOURCE_MISC_SHARED`），
//! 其共享 handle 不能跨顯示卡開啟。因此在未知遊戲位於哪一張顯示卡時，
//! 需依序列舉系統上的硬體轉接器並嘗試 `OpenSharedResource`，選用第一個成功的裝置。

use std::ffi::c_void;

use anyhow::{bail, Context, Result};
use windows::core::Interface;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    DXGI_ERROR_NOT_FOUND,
};

use crate::gpu::Gpu;

fn adapter_name(description: &[u16]) -> String {
    let end = description
        .iter()
        .position(|&ch| ch == 0)
        .unwrap_or(description.len());
    String::from_utf16_lossy(&description[..end])
}

/// 舊式共享 handle 不能跨顯示卡：依序在每張轉接器上建立裝置並嘗試 OpenSharedResource，
/// 回傳第一個成功的裝置與開啟的材質。全部失敗 → "hook_unavailable: ..." 錯誤（列出嘗試過的轉接器名稱）。
pub fn open_shared(handle: u32) -> Result<(Gpu, ID3D11Texture2D)> {
    // SAFETY: 建立 DXGI factory 不需額外前置條件；回傳的 COM 物件由 windows crate 管理。
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.context("hook_unavailable: 建立 DXGI factory 失敗")?;
    let mut tried = Vec::new();
    for index in 0.. {
        // SAFETY: 依序列舉轉接器，序號超出範圍時回傳 DXGI_ERROR_NOT_FOUND。
        let adapter1 = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(error).context("hook_unavailable: 列舉顯示卡失敗"),
        };
        // SAFETY: adapter1 為剛列舉到的有效 COM 物件。
        let desc =
            unsafe { adapter1.GetDesc1() }.context("hook_unavailable: 讀取顯示卡資訊失敗")?;
        if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
            continue;
        }
        let name = adapter_name(&desc.Description);
        let adapter: IDXGIAdapter = adapter1
            .cast()
            .context("hook_unavailable: 轉型 IDXGIAdapter 失敗")?;
        if let Ok(gpu) = Gpu::create_on(&adapter) {
            if let Ok(texture) = open_shared_on(&gpu, handle) {
                return Ok((gpu, texture));
            }
        }
        tried.push(name);
    }
    let list = if tried.is_empty() {
        "無可用硬體顯示卡".to_string()
    } else {
        tried.join("、")
    };
    bail!("hook_unavailable: 無法在任何顯示卡上開啟共享材質（handle=0x{handle:x}，已嘗試：{list}）")
}

/// 在既有裝置上開啟（hook 重新初始化時用）；失敗 → "hook_unavailable: ..."。
pub fn open_shared_on(gpu: &Gpu, handle: u32) -> Result<ID3D11Texture2D> {
    let raw = HANDLE(handle as usize as *mut c_void);
    let mut texture: Option<ID3D11Texture2D> = None;
    // SAFETY: 以舊式 DXGI 共享 handle 在指定裝置上開啟 2D 材質；無效或跨卡 handle 由 D3D11 回傳錯誤。
    unsafe { gpu.device.OpenSharedResource(raw, &mut texture) }
        .with_context(|| format!("hook_unavailable: 無法開啟共享材質（handle=0x{handle:x}）"))?;
    texture.with_context(|| {
        format!("hook_unavailable: OpenSharedResource 未回傳材質（handle=0x{handle:x}）")
    })
}

#[cfg(test)]
mod tests {
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_SHARED, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_DEFAULT,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::IDXGIResource;

    use super::*;

    #[test]
    fn opens_shared_texture_on_matching_adapter_and_rejects_invalid_handle() {
        let creator = Gpu::create().unwrap();
        let desc = D3D11_TEXTURE2D_DESC {
            Width: 64,
            Height: 32,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            MiscFlags: D3D11_RESOURCE_MISC_SHARED.0 as u32,
            ..Default::default()
        };
        let mut source = None;
        // SAFETY: 在測試裝置建立具備 D3D11_RESOURCE_MISC_SHARED 的 2D 材質。
        unsafe {
            creator
                .device
                .CreateTexture2D(&desc, None, Some(&mut source))
                .unwrap();
        }
        let source = source.unwrap();
        let resource: IDXGIResource = source.cast().unwrap();
        // SAFETY: 取得舊式共享資源 handle。
        let shared_handle = unsafe { resource.GetSharedHandle() }.unwrap();
        let handle = shared_handle.0 as usize as u32;

        let (gpu, opened) = open_shared(handle).unwrap();
        let mut opened_desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: 讀取剛開啟的共享材質描述。
        unsafe { opened.GetDesc(&mut opened_desc) };
        assert_eq!(opened_desc.Width, 64);
        assert_eq!(opened_desc.Height, 32);
        assert_eq!(opened_desc.Format, DXGI_FORMAT_R8G8B8A8_UNORM);

        let reopened = open_shared_on(&gpu, handle).unwrap();
        let mut reopened_desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: 讀取在既有裝置重新開啟的共享材質描述。
        unsafe { reopened.GetDesc(&mut reopened_desc) };
        assert_eq!(reopened_desc.Width, 64);
        assert_eq!(reopened_desc.Height, 32);
        assert_eq!(reopened_desc.Format, DXGI_FORMAT_R8G8B8A8_UNORM);

        let err = match open_shared(0xDEAD_BEEF) {
            Ok(_) => panic!("無效 handle 不應開啟成功"),
            Err(err) => err.to_string(),
        };
        assert!(err.starts_with("hook_unavailable:"), "{err}");

        let on_err = open_shared_on(&gpu, 0xDEAD_BEEF).unwrap_err().to_string();
        assert!(on_err.starts_with("hook_unavailable:"), "{on_err}");
    }
}
