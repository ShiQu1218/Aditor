//! Shared D3D11 device used for capture, small-image cropping, and hardware encoding to pass frames without copies.

use anyhow::{Context, Result};
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::IDXGIAdapter;

#[derive(Clone)]
pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
}

// SAFETY: ID3D11Multithread protection is enabled at creation, allowing the immediate context to be used across threads.
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

impl Gpu {
    /// Create a device on the default hardware adapter with BGRA/video support and multithread protection.
    pub fn create() -> Result<Self> {
        Self::create_with(None, D3D_DRIVER_TYPE_HARDWARE)
    }

    /// Create a device on the specified adapter (DDA must use the adapter owning the target display).
    pub fn create_on(adapter: &IDXGIAdapter) -> Result<Self> {
        // The driver type must be UNKNOWN when specifying an adapter.
        Self::create_with(Some(adapter), D3D_DRIVER_TYPE_UNKNOWN)
    }

    fn create_with(adapter: Option<&IDXGIAdapter>, driver: D3D_DRIVER_TYPE) -> Result<Self> {
        let mut device = None;
        let mut context = None;
        // SAFETY: Standard D3D11CreateDevice call; output parameters are managed by the windows crate.
        unsafe {
            D3D11CreateDevice(
                adapter,
                driver,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .context("D3D11CreateDevice failed")?;
        }
        let device: ID3D11Device = device.context("D3D11CreateDevice returned no device")?;
        let context: ID3D11DeviceContext = context.context("D3D11CreateDevice returned no context")?;
        let mt: ID3D11Multithread = context.cast().context("Failed to obtain ID3D11Multithread")?;
        // SAFETY: Only sets a flag.
        unsafe {
            let _ = mt.SetMultithreadProtected(true);
        }
        Ok(Self { device, context })
    }
}
