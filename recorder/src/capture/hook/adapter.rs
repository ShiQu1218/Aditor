//! Selects a graphics adapter and opens a shared texture.
//!
//! OBS graphics-hook uses legacy DXGI shared resources, whose handles cannot be opened across adapters.
//! Its shared handle cannot be opened across adapters. When the game's adapter is unknown,
//! enumerate the system's hardware adapters and try `OpenSharedResource`, using the first device that succeeds.

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

/// Legacy shared handles cannot cross adapters: create a device on each adapter in turn and try OpenSharedResource,
/// returning the first successful device and opened texture. If all attempts fail, returns a "hook_unavailable: ..." error listing the attempted adapters.
pub fn open_shared(handle: u32) -> Result<(Gpu, ID3D11Texture2D)> {
    // SAFETY: Creating a DXGI factory has no additional preconditions; the windows crate manages the returned COM object.
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }
        .context("hook_unavailable: Failed to create DXGI factory")?;
    let mut tried = Vec::new();
    for index in 0.. {
        // SAFETY: Enumerate adapters in order; out-of-range indices return DXGI_ERROR_NOT_FOUND.
        let adapter1 = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => {
                return Err(error).context("hook_unavailable: Failed to enumerate adapters")
            }
        };
        // SAFETY: adapter1 is a valid COM object just enumerated.
        let desc = unsafe { adapter1.GetDesc1() }
            .context("hook_unavailable: Failed to read adapter information")?;
        if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
            continue;
        }
        let name = adapter_name(&desc.Description);
        let adapter: IDXGIAdapter = adapter1
            .cast()
            .context("hook_unavailable: Failed to cast to IDXGIAdapter")?;
        if let Ok(gpu) = Gpu::create_on(&adapter) {
            if let Ok(texture) = open_shared_on(&gpu, handle) {
                return Ok((gpu, texture));
            }
        }
        tried.push(name);
    }
    let list = if tried.is_empty() {
        "No hardware adapters available".to_string()
    } else {
        tried.join(", ")
    };
    bail!("hook_unavailable: Could not open shared texture on any adapter (handle=0x{handle:x}; tried: {list})")
}

/// Opens the texture on an existing device (used when the hook reinitializes); failures return "hook_unavailable: ...".
pub fn open_shared_on(gpu: &Gpu, handle: u32) -> Result<ID3D11Texture2D> {
    let raw = HANDLE(handle as usize as *mut c_void);
    let mut texture: Option<ID3D11Texture2D> = None;
    // SAFETY: Opens a 2D texture on the specified device using a legacy DXGI shared handle; D3D11 reports invalid or cross-adapter handles.
    unsafe { gpu.device.OpenSharedResource(raw, &mut texture) }.with_context(|| {
        format!("hook_unavailable: Could not open shared texture (handle=0x{handle:x})")
    })?;
    texture.with_context(|| {
        format!("hook_unavailable: OpenSharedResource returned no texture (handle=0x{handle:x})")
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
        // SAFETY: Create a 2D texture with D3D11_RESOURCE_MISC_SHARED on the test device.
        unsafe {
            creator
                .device
                .CreateTexture2D(&desc, None, Some(&mut source))
                .unwrap();
        }
        let source = source.unwrap();
        let resource: IDXGIResource = source.cast().unwrap();
        // SAFETY: Get the legacy shared-resource handle.
        let shared_handle = unsafe { resource.GetSharedHandle() }.unwrap();
        let handle = shared_handle.0 as usize as u32;

        let (gpu, opened) = open_shared(handle).unwrap();
        let mut opened_desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: Read the newly opened shared texture description.
        unsafe { opened.GetDesc(&mut opened_desc) };
        assert_eq!(opened_desc.Width, 64);
        assert_eq!(opened_desc.Height, 32);
        assert_eq!(opened_desc.Format, DXGI_FORMAT_R8G8B8A8_UNORM);

        let reopened = open_shared_on(&gpu, handle).unwrap();
        let mut reopened_desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: Read the shared texture description reopened on the existing device.
        unsafe { reopened.GetDesc(&mut reopened_desc) };
        assert_eq!(reopened_desc.Width, 64);
        assert_eq!(reopened_desc.Height, 32);
        assert_eq!(reopened_desc.Format, DXGI_FORMAT_R8G8B8A8_UNORM);

        let err = match open_shared(0xDEAD_BEEF) {
            Ok(_) => panic!("Invalid handle should not open successfully"),
            Err(err) => err.to_string(),
        };
        assert!(err.starts_with("hook_unavailable:"), "{err}");

        let on_err = open_shared_on(&gpu, 0xDEAD_BEEF).unwrap_err().to_string();
        assert!(on_err.starts_with("hook_unavailable:"), "{on_err}");
    }
}
