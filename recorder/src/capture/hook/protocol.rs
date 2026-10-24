//! OBS `graphics-hook` shared-memory protocol, named kernel objects, offset INI parsing, and texture format mapping.
//! References OBS 32.1.2 graphics hook, game capture, and graphics-offset loader source files.
//! OBS 32.1.2 reference files: shared/obs-hook-config/graphics-hook-info.h, plugins/win-capture/game-capture.c, and plugins/win-capture/load-graphics-offsets.c.
//! This module contains only pure functions and data structures; it does not call any Win32 APIs.

use std::fmt;

use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_TYPELESS, DXGI_FORMAT_B8G8R8A8_UNORM,
    DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_FORMAT_B8G8R8X8_TYPELESS, DXGI_FORMAT_B8G8R8X8_UNORM,
    DXGI_FORMAT_B8G8R8X8_UNORM_SRGB, DXGI_FORMAT_R10G10B10A2_TYPELESS,
    DXGI_FORMAT_R10G10B10A2_UNORM, DXGI_FORMAT_R8G8B8A8_TYPELESS, DXGI_FORMAT_R8G8B8A8_UNORM,
    DXGI_FORMAT_R8G8B8A8_UNORM_SRGB,
};

/// Default frame rate used when no valid frame rate is specified.
const DEFAULT_FPS: u32 = 60;
/// Nanoseconds per second (`HookInfo::frame_interval` unit).
const NANOS_PER_SEC: u64 = 1_000_000_000;

/// The graphics_offsets struct from graphics-hook-info.h.
/// Each field is a function or member offset in a target system DLL, obtained by `get-graphics-offsets64.exe` and passed to the hook.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GraphicsOffsets {
    pub d3d8_present: u32,
    pub d3d9: [u32; 5],
    pub dxgi_present: u32,
    pub dxgi_resize: u32,
    pub dxgi_present1: u32,
    pub ddraw: [u32; 8],
    pub dxgi2_release: u32,
    pub d3d12_execute_command_lists: u32,
}

/// The hook_info struct from graphics-hook-info.h (pack 8; equivalent to repr(C) on x64).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HookInfo {
    pub hook_ver_major: u32,
    pub hook_ver_minor: u32,
    pub capture_type: u32,
    pub window: u32,
    pub format: u32,
    pub cx: u32,
    pub cy: u32,
    pub unused_base_cx: u32,
    pub unused_base_cy: u32,
    pub pitch: u32,
    pub map_id: u32,
    pub map_size: u32,
    pub flip: bool,
    pub frame_interval: u64,
    pub unused_use_scale: bool,
    pub force_shmem: bool,
    pub capture_overlay: bool,
    pub allow_srgb_alias: bool,
    pub offsets: GraphicsOffsets,
    pub reserved: [u32; 126],
}

const _: () = assert!(std::mem::size_of::<HookInfo>() == 648);

impl Default for HookInfo {
    fn default() -> Self {
        Self {
            hook_ver_major: 0,
            hook_ver_minor: 0,
            capture_type: 0,
            window: 0,
            format: 0,
            cx: 0,
            cy: 0,
            unused_base_cx: 0,
            unused_base_cy: 0,
            pitch: 0,
            map_id: 0,
            map_size: 0,
            flip: false,
            frame_interval: 0,
            unused_use_scale: false,
            force_shmem: false,
            capture_overlay: false,
            allow_srgb_alias: false,
            offsets: GraphicsOffsets::default(),
            reserved: [0; 126],
        }
    }
}

impl HookInfo {
    /// Writes capture settings and function offsets; treats `fps` as 60 when it is 0 to avoid division by zero and limit the game's copy rate.
    pub fn configure(&mut self, offsets: GraphicsOffsets, fps: u32) {
        let fps = if fps == 0 { DEFAULT_FPS } else { fps };
        self.offsets = offsets;
        self.frame_interval = NANOS_PER_SEC / u64::from(fps);
        self.allow_srgb_alias = true;
        self.force_shmem = false;
        self.capture_overlay = false;
        self.unused_use_scale = false;
    }
}

/// The capture_type enum from graphics-hook-info.h.
/// `HookInfo::capture_type` resides in inter-process shared memory; keep it as `u32` to avoid undefined behavior for unknown values.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureType {
    Memory = 0,
    Texture = 1,
}

impl CaptureType {
    pub const MEMORY: u32 = Self::Memory as u32;
    pub const TEXTURE: u32 = Self::Texture as u32;

    pub const fn from_raw(raw: u32) -> Option<Self> {
        match raw {
            Self::MEMORY => Some(Self::Memory),
            Self::TEXTURE => Some(Self::Texture),
            _ => None,
        }
    }
}

pub fn keepalive(pid: u32) -> String {
    format!("CaptureHook_KeepAlive{pid}")
}

pub fn restart(pid: u32) -> String {
    format!("CaptureHook_Restart{pid}")
}

pub fn stop(pid: u32) -> String {
    format!("CaptureHook_Stop{pid}")
}

pub fn ready(pid: u32) -> String {
    format!("CaptureHook_HookReady{pid}")
}

#[allow(dead_code)] // Retained to match the complete OBS named-event specification.
pub fn exit(pid: u32) -> String {
    format!("CaptureHook_Exit{pid}")
}

pub fn init(pid: u32) -> String {
    format!("CaptureHook_Initialize{pid}")
}

pub fn texture_mutex(pid: u32, index: u32) -> String {
    format!("CaptureHook_TextureMutex{index}{pid}")
}

pub fn hook_info(pid: u32) -> String {
    format!("CaptureHook_HookInfo{pid}")
}

pub fn texture_map(window: u32, map_id: u32) -> String {
    format!("CaptureHook_Texture_{window}_{map_id}")
}

pub fn pipe(pid: u32) -> String {
    format!(r"\\.\pipe\CaptureHook_Pipe{pid}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OffsetsError {
    InvalidValue { key: String, value: String },
    MissingDxgi,
}

impl fmt::Display for OffsetsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidValue { key, value } => write!(f, "Unable to parse offset {key}={value}"),
            Self::MissingDxgi => write!(f, "Missing DXGI offset (dxgi.present or dxgi.resize)"),
        }
    }
}

impl std::error::Error for OffsetsError {}

/// Parses the INI output from get-graphics-offsets64.exe.
/// Ignores unknown sections/keys; returns an error if `dxgi.present` or `dxgi.resize` is zero or missing (the hook needs both to hook DXGI).
pub fn parse_offsets(text: &str) -> Result<GraphicsOffsets, OffsetsError> {
    let mut section = "";
    let mut offsets = GraphicsOffsets::default();
    for line in text.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            section = name.trim();
            continue;
        }
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let target = match (section, key) {
            ("d3d8", "present") => &mut offsets.d3d8_present,
            ("d3d9", "present") => &mut offsets.d3d9[0],
            ("d3d9", "present_ex") => &mut offsets.d3d9[1],
            ("d3d9", "present_swap") => &mut offsets.d3d9[2],
            ("d3d9", "d3d9_clsoff") => &mut offsets.d3d9[3],
            ("d3d9", "is_d3d9ex_clsoff") => &mut offsets.d3d9[4],
            ("dxgi", "present") => &mut offsets.dxgi_present,
            ("dxgi", "present1") => &mut offsets.dxgi_present1,
            ("dxgi", "resize") => &mut offsets.dxgi_resize,
            ("dxgi", "release") => &mut offsets.dxgi2_release,
            _ => continue,
        };
        let raw_value = raw_value.trim();
        let hex = raw_value
            .strip_prefix("0x")
            .or_else(|| raw_value.strip_prefix("0X"))
            .unwrap_or(raw_value);
        let value = u32::from_str_radix(hex, 16).map_err(|_| OffsetsError::InvalidValue {
            key: format!("{section}.{key}"),
            value: raw_value.to_string(),
        })?;
        *target = value;
    }
    if offsets.dxgi_present == 0 || offsets.dxgi_resize == 0 {
        return Err(OffsetsError::MissingDxgi);
    }
    Ok(offsets)
}

/// Method for converting the hook's shared texture to our own `B8G8R8A8_UNORM` texture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextureConversion {
    /// Same typeless family as `B8G8R8A8_UNORM`; copy directly with `CopyResource` (SRGB is a different view of the same bytes).
    Copy,
    /// `B8G8R8X8_*`: copy BGR with a compute shader and set alpha to 1.
    Bgrx8,
    /// `R8G8B8A8_*`: swap the R/B channels with a compute shader and write to a BGRA UAV.
    SwizzleRgba8,
    /// `R10G10B10A2_*`: convert 10-bit RGB to 8-bit BGRA with a compute shader.
    Rgb10a2,
}

/// Selects a texture conversion method from `HookInfo::format` (a `DXGI_FORMAT` value); returns `None` for unsupported formats.
pub fn conversion_for(dxgi_format: u32) -> Option<TextureConversion> {
    match DXGI_FORMAT(dxgi_format as i32) {
        DXGI_FORMAT_B8G8R8A8_TYPELESS
        | DXGI_FORMAT_B8G8R8A8_UNORM
        | DXGI_FORMAT_B8G8R8A8_UNORM_SRGB => Some(TextureConversion::Copy),
        DXGI_FORMAT_B8G8R8X8_TYPELESS
        | DXGI_FORMAT_B8G8R8X8_UNORM
        | DXGI_FORMAT_B8G8R8X8_UNORM_SRGB => Some(TextureConversion::Bgrx8),
        DXGI_FORMAT_R8G8B8A8_TYPELESS
        | DXGI_FORMAT_R8G8B8A8_UNORM
        | DXGI_FORMAT_R8G8B8A8_UNORM_SRGB => Some(TextureConversion::SwizzleRgba8),
        DXGI_FORMAT_R10G10B10A2_TYPELESS | DXGI_FORMAT_R10G10B10A2_UNORM => {
            Some(TextureConversion::Rgb10a2)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::mem::{align_of, offset_of, size_of};

    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_NV12, DXGI_FORMAT_R10G10B10A2_UINT, DXGI_FORMAT_R16G16B16A16_FLOAT,
        DXGI_FORMAT_UNKNOWN,
    };

    use super::*;

    const SAMPLE_INI: &str = "\
[d3d8]
present=0x1010
[d3d9]
present=0x2010
present_ex=0x2020
present_swap=0x2030
d3d9_clsoff=0x2040
is_d3d9ex_clsoff=0x2050
[dxgi]
present=0x14070
present1=0x14080
resize=0x14090
release=0x140a0
";

    #[test]
    fn hook_info_layout_matches_obs_abi() {
        assert_eq!(size_of::<GraphicsOffsets>(), 76);
        assert_eq!(size_of::<HookInfo>(), 648);
        assert_eq!(align_of::<HookInfo>(), 8);
        assert_eq!(offset_of!(HookInfo, flip), 48);
        assert_eq!(offset_of!(HookInfo, frame_interval), 56);
        assert_eq!(offset_of!(HookInfo, allow_srgb_alias), 67);
        assert_eq!(offset_of!(HookInfo, offsets), 68);
        assert_eq!(offset_of!(HookInfo, reserved), 144);
        assert_eq!(CaptureType::MEMORY, 0);
        assert_eq!(CaptureType::TEXTURE, 1);
        assert_eq!(CaptureType::from_raw(0), Some(CaptureType::Memory));
        assert_eq!(CaptureType::from_raw(1), Some(CaptureType::Texture));
        assert_eq!(CaptureType::from_raw(2), None);
    }

    #[test]
    fn named_object_names_match_obs_format() {
        let pid = 4242;
        assert_eq!(keepalive(pid), "CaptureHook_KeepAlive4242");
        assert_eq!(restart(pid), "CaptureHook_Restart4242");
        assert_eq!(stop(pid), "CaptureHook_Stop4242");
        assert_eq!(ready(pid), "CaptureHook_HookReady4242");
        assert_eq!(exit(pid), "CaptureHook_Exit4242");
        assert_eq!(init(pid), "CaptureHook_Initialize4242");
        assert_eq!(texture_mutex(pid, 1), "CaptureHook_TextureMutex14242");
        assert_eq!(texture_mutex(pid, 2), "CaptureHook_TextureMutex24242");
        assert_eq!(hook_info(pid), "CaptureHook_HookInfo4242");
        assert_eq!(texture_map(0x0012_3456, 7), "CaptureHook_Texture_1193046_7");
        assert_eq!(pipe(pid), r"\\.\pipe\CaptureHook_Pipe4242");
    }

    #[test]
    fn parses_valid_graphics_offsets_ini() {
        let offsets = parse_offsets(SAMPLE_INI).unwrap();
        assert_eq!(
            offsets,
            GraphicsOffsets {
                d3d8_present: 0x1010,
                d3d9: [0x2010, 0x2020, 0x2030, 0x2040, 0x2050],
                dxgi_present: 0x14070,
                dxgi_resize: 0x14090,
                dxgi_present1: 0x14080,
                ddraw: [0; 8],
                dxgi2_release: 0x140a0,
                d3d12_execute_command_lists: 0,
            }
        );
    }

    #[test]
    fn parses_crlf_lines_and_ignores_unknown_sections_and_keys() {
        let ini =
            "[vk]\r\npresent=bad\r\n[dxgi]\r\npresent=0x1234\r\nextra=0x9\r\nresize=0x5678\r\n";
        let offsets = parse_offsets(ini).unwrap();
        assert_eq!(offsets.dxgi_present, 0x1234);
        assert_eq!(offsets.dxgi_resize, 0x5678);
    }

    #[test]
    fn rejects_offsets_when_dxgi_present_or_resize_is_missing_or_zero() {
        let missing_resize = "[dxgi]\npresent=0x14070\npresent1=0x14080\n";
        assert_eq!(
            parse_offsets(missing_resize),
            Err(OffsetsError::MissingDxgi)
        );

        let zero_resize = "[dxgi]\npresent=0x14070\nresize=0x0\n";
        assert_eq!(parse_offsets(zero_resize), Err(OffsetsError::MissingDxgi));

        let missing_present = "[dxgi]\nresize=0x14090\n";
        assert_eq!(
            parse_offsets(missing_present),
            Err(OffsetsError::MissingDxgi)
        );
    }

    #[test]
    fn rejects_invalid_hex_value_with_key_name_in_error() {
        let bad = "[dxgi]\npresent=0x14070\nresize=0xzz\n";
        let err = parse_offsets(bad).unwrap_err();
        assert_eq!(
            err,
            OffsetsError::InvalidValue {
                key: "dxgi.resize".into(),
                value: "0xzz".into(),
            }
        );
        assert!(err.to_string().contains("resize"));
    }

    #[test]
    fn configure_sets_offsets_flags_and_frame_interval_with_zero_fps_fallback() {
        let offsets = parse_offsets(SAMPLE_INI).unwrap();
        let mut info = HookInfo {
            unused_use_scale: true,
            force_shmem: true,
            capture_overlay: true,
            allow_srgb_alias: false,
            ..HookInfo::default()
        };
        info.configure(offsets, 120);
        assert_eq!(info.offsets, offsets);
        assert_eq!(info.frame_interval, 1_000_000_000 / 120);
        assert!(info.allow_srgb_alias);
        assert!(!info.force_shmem);
        assert!(!info.capture_overlay);
        assert!(!info.unused_use_scale);

        info.configure(offsets, 0);
        assert_eq!(info.frame_interval, 1_000_000_000 / 60);
    }

    #[test]
    fn maps_dxgi_formats_to_texture_conversion() {
        for format in [
            DXGI_FORMAT_B8G8R8A8_TYPELESS,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            DXGI_FORMAT_B8G8R8A8_UNORM_SRGB,
        ] {
            assert_eq!(
                conversion_for(format.0 as u32),
                Some(TextureConversion::Copy),
                "{format:?}"
            );
        }
        for format in [
            DXGI_FORMAT_B8G8R8X8_TYPELESS,
            DXGI_FORMAT_B8G8R8X8_UNORM,
            DXGI_FORMAT_B8G8R8X8_UNORM_SRGB,
        ] {
            assert_eq!(
                conversion_for(format.0 as u32),
                Some(TextureConversion::Bgrx8),
                "{format:?}"
            );
        }
        for format in [
            DXGI_FORMAT_R8G8B8A8_TYPELESS,
            DXGI_FORMAT_R8G8B8A8_UNORM,
            DXGI_FORMAT_R8G8B8A8_UNORM_SRGB,
        ] {
            assert_eq!(
                conversion_for(format.0 as u32),
                Some(TextureConversion::SwizzleRgba8),
                "{format:?}"
            );
        }
        for format in [
            DXGI_FORMAT_R10G10B10A2_TYPELESS,
            DXGI_FORMAT_R10G10B10A2_UNORM,
        ] {
            assert_eq!(
                conversion_for(format.0 as u32),
                Some(TextureConversion::Rgb10a2),
                "{format:?}"
            );
        }
        for format in [
            DXGI_FORMAT_UNKNOWN,
            DXGI_FORMAT_NV12,
            DXGI_FORMAT_R16G16B16A16_FLOAT,
            DXGI_FORMAT_R10G10B10A2_UINT,
        ] {
            assert_eq!(conversion_for(format.0 as u32), None, "{format:?}");
        }
    }
}
