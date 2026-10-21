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
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    DXGI_ERROR_NOT_FOUND,
};

/// Microsoft's software renderer vendor ID reported by the Basic Render Driver.
const MICROSOFT_VENDOR_ID: u32 = 0x1414;

/// Graphics vendor used to pick the matching hardware encoder family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Vendor {
    /// NVIDIA (NVENC).
    Nvidia,
    /// AMD (AMF).
    Amd,
    /// Intel (Quick Sync).
    Intel,
    /// Any other vendor without a known hardware encoder family.
    Other,
}

impl Vendor {
    /// Map a DXGI vendor ID to its vendor.
    pub fn from_vendor_id(vendor_id: u32) -> Self {
        match vendor_id {
            0x10de => Self::Nvidia,
            0x1002 => Self::Amd,
            0x8086 => Self::Intel,
            _ => Self::Other,
        }
    }

    /// Stable lower-case vendor name used by the IPC protocol and the app.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nvidia => "nvidia",
            Self::Amd => "amd",
            Self::Intel => "intel",
            Self::Other => "other",
        }
    }

    /// Hardware encoder family supported by this vendor, or `None` for unknown vendors.
    pub fn encoder_family(self) -> Option<&'static str> {
        match self {
            Self::Nvidia => Some("nvenc"),
            Self::Amd => Some("amf"),
            Self::Intel => Some("qsv"),
            Self::Other => None,
        }
    }
}

/// Info needed to identify and rank a DXGI adapter without creating a device on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterDesc {
    /// Adapter name reported by DXGI.
    pub name: String,
    /// PCI vendor ID.
    pub vendor_id: u32,
    /// PCI device ID.
    pub device_id: u32,
    /// DXGI software adapter or the Microsoft Basic Render Driver.
    pub software: bool,
}

impl AdapterDesc {
    /// Vendor priority for automatic selection; lower values win.
    fn priority(&self) -> u8 {
        match Vendor::from_vendor_id(self.vendor_id) {
            Vendor::Nvidia => 0,
            Vendor::Amd => 1,
            Vendor::Intel => 2,
            Vendor::Other => 3,
        }
    }
}

/// Stable adapter IDs: `{vendor_id:04x}:{device_id:04x}`, with `#2`, `#3`, ... for duplicates.
pub fn adapter_ids(descs: &[AdapterDesc]) -> Vec<String> {
    let mut counts = std::collections::HashMap::new();
    descs
        .iter()
        .map(|desc| {
            let base = format!("{:04x}:{:04x}", desc.vendor_id, desc.device_id);
            let count = counts.entry(base.clone()).or_insert(0u32);
            *count += 1;
            if *count == 1 {
                base
            } else {
                format!("{base}#{count}")
            }
        })
        .collect()
}

/// Indices of hardware adapters ordered by vendor priority (NVIDIA, AMD, Intel, Other), stable within a vendor.
pub fn auto_order(descs: &[AdapterDesc]) -> Vec<usize> {
    let mut indices: Vec<usize> = descs
        .iter()
        .enumerate()
        .filter(|(_, desc)| !desc.software)
        .map(|(index, _)| index)
        .collect();
    indices.sort_by_key(|&index| descs[index].priority());
    indices
}

/// Enumerated DXGI adapter that can create a D3D11 device for capture and encoding.
pub struct GpuAdapter {
    /// Stable ID reported by `hello` and accepted in `EncodeConfig.gpu`.
    pub id: String,
    /// Adapter information used for ordering and display.
    pub desc: AdapterDesc,
    adapter: IDXGIAdapter,
}

impl GpuAdapter {
    /// Create a device on this adapter with the same options as `Gpu::create`.
    pub fn create_gpu(&self) -> Result<Gpu> {
        Gpu::create_on(&self.adapter)
    }
}

#[derive(Clone)]
pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
}

// SAFETY: ID3D11Multithread protection is enabled at creation, allowing the immediate context to be used across threads.
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

impl Gpu {
    /// Enumerate DXGI adapters in enumeration order, assigning stable IDs.
    pub fn enumerate() -> Result<Vec<GpuAdapter>> {
        let factory: IDXGIFactory1 =
            // SAFETY: Creating a DXGI factory has no preconditions; the windows crate manages the COM object.
            unsafe { CreateDXGIFactory1() }.context("Failed to create DXGI factory")?;
        let mut entries: Vec<(IDXGIAdapter, AdapterDesc)> = Vec::new();
        for index in 0.. {
            // SAFETY: Enumerate in order; an out-of-range index returns DXGI_ERROR_NOT_FOUND.
            match unsafe { factory.EnumAdapters1(index) } {
                Ok(adapter) => {
                    // SAFETY: adapter is a valid COM object just enumerated.
                    let raw = unsafe { adapter.GetDesc1() }
                        .context("Failed to read DXGI adapter information")?;
                    let desc = AdapterDesc {
                        name: String::from_utf16_lossy(&raw.Description)
                            .trim_end_matches('\0')
                            .to_owned(),
                        vendor_id: raw.VendorId,
                        device_id: raw.DeviceId,
                        software: raw.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0
                            || raw.VendorId == MICROSOFT_VENDOR_ID,
                    };
                    entries.push((adapter.cast()?, desc));
                }
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(error) => return Err(error).context("Failed to enumerate DXGI adapters"),
            }
        }
        let descs: Vec<_> = entries.iter().map(|(_, desc)| desc.clone()).collect();
        let ids = adapter_ids(&descs);
        Ok(entries
            .into_iter()
            .zip(ids)
            .map(|((adapter, desc), id)| GpuAdapter { id, desc, adapter })
            .collect())
    }

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
        let context: ID3D11DeviceContext =
            context.context("D3D11CreateDevice returned no context")?;
        let mt: ID3D11Multithread = context
            .cast()
            .context("Failed to obtain ID3D11Multithread")?;
        // SAFETY: Only sets a flag.
        unsafe {
            let _ = mt.SetMultithreadProtected(true);
        }
        Ok(Self { device, context })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desc(vendor_id: u32, device_id: u32, software: bool) -> AdapterDesc {
        AdapterDesc {
            name: format!("GPU {vendor_id:04x}:{device_id:04x}"),
            vendor_id,
            device_id,
            software,
        }
    }

    #[test]
    fn vendor_ids_map_to_names_and_encoder_families() {
        for (id, vendor, family) in [
            (0x10de, Vendor::Nvidia, Some("nvenc")),
            (0x1002, Vendor::Amd, Some("amf")),
            (0x8086, Vendor::Intel, Some("qsv")),
            (0x1414, Vendor::Other, None),
            (0, Vendor::Other, None),
        ] {
            assert_eq!(Vendor::from_vendor_id(id), vendor);
            assert_eq!(vendor.encoder_family(), family);
        }
        assert_eq!(Vendor::Nvidia.as_str(), "nvidia");
        assert_eq!(Vendor::Amd.as_str(), "amd");
        assert_eq!(Vendor::Intel.as_str(), "intel");
        assert_eq!(Vendor::Other.as_str(), "other");
    }

    #[test]
    fn adapter_ids_use_lowercase_hex_and_suffix_duplicates_in_enumeration_order() {
        let descs = [
            desc(0x10de, 0x0abc, false),
            desc(0x10de, 0x0abc, false),
            desc(0x8086, 0x0046, false),
            desc(0x10de, 0x0abc, true),
        ];
        assert_eq!(
            adapter_ids(&descs),
            ["10de:0abc", "10de:0abc#2", "8086:0046", "10de:0abc#3"]
        );
        assert!(adapter_ids(&[]).is_empty());
    }

    #[test]
    fn auto_order_skips_software_adapters_and_keeps_vendor_priority_stable() {
        let descs = [
            desc(0x8086, 1, false),
            desc(0x1414, 2, true),
            desc(0x10de, 3, false),
            desc(0x1002, 4, false),
            desc(0x10de, 5, false),
            desc(0x1234, 6, false),
            desc(0x10de, 7, true),
        ];
        assert_eq!(auto_order(&descs), [2, 4, 3, 0, 5]);
        assert!(auto_order(&descs[1..2]).is_empty());
    }
}
