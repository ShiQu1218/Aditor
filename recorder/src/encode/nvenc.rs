//! Checks whether the installed NVIDIA driver supports the NVENC API the bundled FFmpeg was built against.
use windows::core::{s, w};
use windows::Win32::Foundation::FreeLibrary;
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
};

/// NVENC API required by the bundled FFmpeg 8.1 build (BtbN builds it with nv-codec-headers sdk/13.0).
/// Update together with scripts/fetch-ffmpeg.ps1.
pub(super) const REQUIRED_API: (u32, u32) = (13, 0);
/// Minimum NVIDIA driver FFmpeg documents for REQUIRED_API, spelled exactly as FFmpeg embeds it in avcodec.
pub(super) const MIN_DRIVER: &str = "570.0";

/// Returns the highest NVENC API version (major, minor) the driver supports, or None without an NVENC runtime.
pub(super) fn driver_api() -> Option<(u32, u32)> {
    // SAFETY: The module handle stays loaded while the export is called and is released once afterwards;
    // NvEncodeAPIGetMaxSupportedVersion takes a single writable u32 pointer and returns an NVENCSTATUS.
    unsafe {
        let module =
            LoadLibraryExW(w!("nvEncodeAPI64.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
        let version =
            GetProcAddress(module, s!("NvEncodeAPIGetMaxSupportedVersion")).and_then(|export| {
                let query: unsafe extern "system" fn(*mut u32) -> i32 = std::mem::transmute(export);
                let mut version = 0u32;
                (query(&mut version) == 0).then_some(version)
            });
        let _ = FreeLibrary(module);
        version.map(|version| (version >> 4, version & 0xf))
    }
}
