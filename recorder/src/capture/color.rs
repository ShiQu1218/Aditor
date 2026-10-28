//! Convert linear scRGB capture to SDR before passing it to encoding or analysis.
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{ensure, Context, Result};
use windows::core::s;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Devices::Display::*;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Gdi::*;

use crate::gpu::Gpu;

#[derive(Clone, Copy)]
pub(super) enum DisplayState {
    Sdr,
    Hdr,
    Unknown,
}

impl DisplayState {
    pub(super) fn pool_format(self) -> DirectXPixelFormat {
        match self {
            Self::Sdr => DirectXPixelFormat::B8G8R8A8UIntNormalized,
            Self::Hdr | Self::Unknown => DirectXPixelFormat::R16G16B16A16Float,
        }
    }

    pub(super) fn log_pool_format(self) {
        let description = match self {
            Self::Sdr => "BGRA8 (SDR display)",
            Self::Hdr => "FP16 (HDR display)",
            Self::Unknown => "FP16 (display state unknown)",
        };
        eprintln!("WGC: frame pool format {description}");
    }
}

pub(super) fn display_state(monitor: HMONITOR) -> DisplayState {
    sdr_white(monitor).map_or(DisplayState::Unknown, |(state, _)| state)
}

pub(super) struct SdrConverter {
    gpu: Gpu,
    context: ID3D11DeviceContext,
    vertex: ID3D11VertexShader,
    pixel: ID3D11PixelShader,
    levels: ID3D11Buffer,
    sampler: ID3D11SamplerState,
    requested: Option<Arc<OnceLock<(u32, u32)>>>,
    sources: Vec<(ID3D11Texture2D, Option<ID3D11ShaderResourceView>)>,
    input: Option<(ID3D11Texture2D, ID3D11ShaderResourceView)>,
    surfaces: Option<Surfaces>,
    monitor: isize,
    white: f32,
    hdr: bool,
    refresh: Instant,
}

struct Surfaces {
    source_size: (u32, u32),
    size: (u32, u32),
    output: ID3D11Texture2D,
    target: ID3D11RenderTargetView,
}

impl SdrConverter {
    pub(super) fn new(gpu: &Gpu, requested: Option<Arc<OnceLock<(u32, u32)>>>) -> Result<Self> {
        let mut vertex = None;
        let mut pixel = None;
        let mut levels = None;
        let mut context = None;
        let mut sampler = None;
        // SAFETY: Bytecode and descriptors remain valid for each synchronous device call.
        unsafe {
            for (is_vertex, entry, profile) in [
                (true, s!("vertex"), s!("vs_5_0")),
                (false, s!("pixel"), s!("ps_5_0")),
            ] {
                let source = include_str!("color.hlsl");
                let mut code = None;
                let mut errors = None;
                D3DCompile(
                    source.as_ptr().cast(),
                    source.len(),
                    s!("aditorrec-color"),
                    None,
                    None,
                    entry,
                    profile,
                    0,
                    0,
                    &mut code,
                    Some(&mut errors),
                )
                .context("Failed to compile SDR conversion shader")?;
                let code = code.context("Missing SDR shader bytecode")?;
                let bytes = std::slice::from_raw_parts(
                    code.GetBufferPointer().cast::<u8>(),
                    code.GetBufferSize(),
                );
                if is_vertex {
                    gpu.device
                        .CreateVertexShader(bytes, None, Some(&mut vertex))?;
                } else {
                    gpu.device
                        .CreatePixelShader(bytes, None, Some(&mut pixel))?;
                }
            }
            gpu.device.CreateBuffer(
                &D3D11_BUFFER_DESC {
                    ByteWidth: 16,
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut levels),
            )?;
            gpu.device.CreateSamplerState(
                &D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    MaxLOD: f32::MAX,
                    ..Default::default()
                },
                Some(&mut sampler),
            )?;
            gpu.device.CreateDeferredContext(0, Some(&mut context))?;
        }
        Ok(Self {
            gpu: gpu.clone(),
            context: context.context("Missing SDR context")?,
            vertex: vertex.context("Missing SDR vertex shader")?,
            pixel: pixel.context("Missing SDR pixel shader")?,
            levels: levels.context("Missing SDR constants")?,
            sampler: sampler.context("Missing SDR sampler")?,
            requested,
            sources: Vec::new(),
            input: None,
            surfaces: None,
            monitor: 0,
            white: 1.0,
            hdr: false,
            refresh: Instant::now(),
        })
    }

    pub(super) fn convert(
        &mut self,
        source: &ID3D11Texture2D,
        monitor: HMONITOR,
    ) -> Result<ID3D11Texture2D> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: source remains alive throughout conversion.
        unsafe { source.GetDesc(&mut desc) };
        if desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM {
            // After an HDR-to-SDR switch nothing would evict the cached FP16 pool textures.
            self.sources.clear();
            return Ok(source.clone());
        }
        ensure!(
            desc.Format == DXGI_FORMAT_R16G16B16A16_FLOAT && desc.SampleDesc.Count == 1,
            "Unsupported capture color format {}",
            desc.Format.0
        );
        if self.monitor != monitor.0 as isize || Instant::now() >= self.refresh {
            if let Some((_, (white, hdr))) = sdr_white(monitor) {
                self.white = white;
                self.hdr = hdr;
            }
            self.monitor = monitor.0 as isize;
            self.refresh = Instant::now() + Duration::from_secs(1);
        }
        let source_size = (desc.Width, desc.Height);
        let size = conversion_size(
            source_size,
            self.requested.as_ref().and_then(|s| s.get().copied()),
        );
        if self
            .surfaces
            .as_ref()
            .is_none_or(|s| s.source_size != source_size || s.size != size)
        {
            self.surfaces = Some(Surfaces::new(&self.gpu, source_size, size)?);
            self.sources.clear();
            self.input = None;
        }
        let view =
            if let Some((_, view)) = self.sources.iter().find(|(texture, _)| texture == source) {
                view.clone()
            } else {
                let mut view = None;
                if desc.BindFlags & D3D11_BIND_SHADER_RESOURCE.0 as u32 != 0 {
                    // SAFETY: The source is a single-sample FP16 texture on the capture device.
                    if unsafe {
                        self.gpu
                            .device
                            .CreateShaderResourceView(source, None, Some(&mut view))
                    }
                    .is_err()
                    {
                        view = None;
                    }
                }
                // WGC rotates a small pool; bound retained resources across capture restarts.
                if self.sources.len() == 4 {
                    self.sources.remove(0);
                }
                self.sources.push((source.clone(), view.clone()));
                view
            };
        if view.is_none() && self.input.is_none() {
            let mut input = None;
            let mut input_view = None;
            let input_desc = D3D11_TEXTURE2D_DESC {
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                Usage: D3D11_USAGE_DEFAULT,
                CPUAccessFlags: 0,
                MiscFlags: 0,
                ..desc
            };
            // SAFETY: The private input matches the source for CopyResource and permits sampling.
            unsafe {
                self.gpu
                    .device
                    .CreateTexture2D(&input_desc, None, Some(&mut input))?;
                self.gpu.device.CreateShaderResourceView(
                    input.as_ref().context("Missing scRGB input")?,
                    None,
                    Some(&mut input_view),
                )?;
            }
            self.input = Some((
                input.context("Missing scRGB input")?,
                input_view.context("Missing scRGB view")?,
            ));
        }
        let surfaces = self.surfaces.as_ref().context("Missing SDR surfaces")?;
        let levels = [
            self.white,
            if self.hdr { 1.0 } else { 0.0 },
            source_size.0 as f32 / size.0 as f32,
            source_size.1 as f32 / size.1 as f32,
        ];
        let mut commands = None;
        // SAFETY: This private deferred context owns its state. ExecuteCommandList submits
        // the copy and draw atomically, preserving the shared immediate context's state.
        unsafe {
            let view = match view {
                Some(view) => view,
                None => {
                    let (input, view) =
                        self.input.as_ref().context("Missing scRGB copy surfaces")?;
                    self.context.CopyResource(input, source);
                    view.clone()
                }
            };
            self.context
                .UpdateSubresource(&self.levels, 0, None, levels.as_ptr().cast(), 0, 0);
            self.context
                .IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.VSSetShader(&self.vertex, None);
            self.context.PSSetShader(&self.pixel, None);
            self.context
                .PSSetConstantBuffers(0, Some(&[Some(self.levels.clone())]));
            self.context.PSSetShaderResources(0, Some(&[Some(view)]));
            self.context
                .OMSetRenderTargets(Some(&[Some(surfaces.target.clone())]), None);
            self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                Width: size.0 as f32,
                Height: size.1 as f32,
                MaxDepth: 1.0,
                ..Default::default()
            }]));
            self.context
                .PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.context.Draw(3, 0);
            self.context.FinishCommandList(false, Some(&mut commands))?;
            self.gpu
                .context
                .ExecuteCommandList(&commands.context("Missing SDR commands")?, true);
            // Submit source reads before the caller releases the WGC frame or DDA acquisition.
            self.gpu.context.Flush();
        }
        Ok(surfaces.output.clone())
    }
}

impl Surfaces {
    fn new(gpu: &Gpu, source_size: (u32, u32), size: (u32, u32)) -> Result<Self> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            ..Default::default()
        };
        let (mut output, mut target) = (None, None);
        // SAFETY: The descriptor selects a single-mip BGRA texture and an RTV on the same device.
        unsafe {
            gpu.device.CreateTexture2D(&desc, None, Some(&mut output))?;
            gpu.device.CreateRenderTargetView(
                output.as_ref().context("Missing SDR output")?,
                None,
                Some(&mut target),
            )?;
        }
        Ok(Self {
            source_size,
            size,
            output: output.context("Missing SDR output")?,
            target: target.context("Missing SDR render target")?,
        })
    }
}

fn conversion_size(source: (u32, u32), requested: Option<(u32, u32)>) -> (u32, u32) {
    let Some((width, height)) = requested else {
        return source;
    };
    // Analysis stretches to 1920x1080 before cropping, so preserve detail on both axes.
    let scale = (width.max(1920) as f64 / source.0 as f64)
        .max(height.max(1080) as f64 / source.1 as f64)
        .min(1.0);
    (
        (source.0 as f64 * scale).ceil() as u32,
        (source.1 as f64 * scale).ceil() as u32,
    )
}

// Keep converter fallbacks separate from whether the display mode was confirmed.
fn sdr_white(monitor: HMONITOR) -> Option<(DisplayState, (f32, bool))> {
    // SDRWhiteLevel is an 80-nit multiplier times 1000, matching scRGB's 1.0 = 80 nits:
    // https://learn.microsoft.com/windows/win32/api/wingdi/ns-wingdi-displayconfig_sdr_white_level
    // SAFETY: All display API structures are initialized with their documented sizes.
    unsafe {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of_val(&info) as u32;
        if !GetMonitorInfoW(monitor, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
            return None;
        }
        let (mut paths, mut modes) = (0, 0);
        GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut paths, &mut modes)
            .ok()
            .ok()?;
        let mut path_data = vec![DISPLAYCONFIG_PATH_INFO::default(); paths as usize];
        let mut mode_data = vec![DISPLAYCONFIG_MODE_INFO::default(); modes as usize];
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut paths,
            path_data.as_mut_ptr(),
            &mut modes,
            mode_data.as_mut_ptr(),
            None,
        )
        .ok()
        .ok()?;
        for path in &path_data[..paths as usize] {
            let mut name = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            name.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: std::mem::size_of_val(&name) as u32,
                adapterId: path.sourceInfo.adapterId,
                id: path.sourceInfo.id,
            };
            if DisplayConfigGetDeviceInfo(&mut name.header) != 0
                || name.viewGdiDeviceName != info.szDevice
            {
                continue;
            }
            let mut color = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO::default();
            color.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                size: std::mem::size_of_val(&color) as u32,
                adapterId: path.targetInfo.adapterId,
                id: path.targetInfo.id,
            };
            if DisplayConfigGetDeviceInfo(&mut color.header) != 0 {
                return Some((DisplayState::Unknown, (1.0, false)));
            }
            if color.Anonymous.value & 2 == 0 {
                return Some((DisplayState::Sdr, (1.0, false)));
            }
            let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL::default();
            white.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
                size: std::mem::size_of_val(&white) as u32,
                adapterId: path.targetInfo.adapterId,
                id: path.targetInfo.id,
            };
            if DisplayConfigGetDeviceInfo(&mut white.header) == 0 && white.SDRWhiteLevel > 0 {
                return Some((
                    DisplayState::Hdr,
                    (white.SDRWhiteLevel as f32 / 1000.0, true),
                ));
            }
            return Some((DisplayState::Unknown, (1.0, true)));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_format_requires_confirmed_sdr() {
        assert_eq!(
            DisplayState::Sdr.pool_format(),
            DirectXPixelFormat::B8G8R8A8UIntNormalized
        );
        for state in [DisplayState::Hdr, DisplayState::Unknown] {
            assert_eq!(state.pool_format(), DirectXPixelFormat::R16G16B16A16Float);
        }
    }

    fn input(gpu: &Gpu, size: (u32, u32), rgb: [f32; 4]) -> ID3D11Texture2D {
        let mut texture = None;
        let mut view = None;
        // SAFETY: Both texture and RTV belong to this test's device.
        unsafe {
            gpu.device
                .CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: size.0,
                        Height: size.1,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_DEFAULT,
                        BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                        ..Default::default()
                    },
                    None,
                    Some(&mut texture),
                )
                .unwrap();
            let texture = texture.as_ref().unwrap();
            gpu.device
                .CreateRenderTargetView(texture, None, Some(&mut view))
                .unwrap();
            gpu.context
                .ClearRenderTargetView(view.as_ref().unwrap(), &rgb);
        }
        texture.unwrap()
    }

    fn read(gpu: &Gpu, texture: &ID3D11Texture2D) -> [u8; 4] {
        read_all(gpu, texture)[0]
    }

    fn read_all(gpu: &Gpu, texture: &ID3D11Texture2D) -> Vec<[u8; 4]> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        let mut staging = None;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: Map is balanced by Unmap; read only valid rows while mapped.
        unsafe {
            texture.GetDesc(&mut desc);
            assert_eq!(desc.Format, DXGI_FORMAT_B8G8R8A8_UNORM);
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            gpu.device
                .CreateTexture2D(&desc, None, Some(&mut staging))
                .unwrap();
            let staging = staging.unwrap();
            gpu.context.CopyResource(&staging, texture);
            gpu.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .unwrap();
            let mut pixels = Vec::with_capacity((desc.Width * desc.Height) as usize);
            for y in 0..desc.Height as usize {
                let row = mapped
                    .pData
                    .cast::<u8>()
                    .add(y * mapped.RowPitch as usize)
                    .cast::<[u8; 4]>();
                pixels.extend_from_slice(std::slice::from_raw_parts(row, desc.Width as usize));
            }
            gpu.context.Unmap(&staging, 0);
            pixels
        }
    }

    #[test]
    fn conversion_preserves_requirements_aspect_and_source_limit() {
        for (source, requested, expected) in [
            ((3840, 2160), None, (3840, 2160)),
            ((3840, 2160), Some((1920, 1080)), (1920, 1080)),
            ((3840, 2160), Some((1280, 720)), (1920, 1080)),
            ((3840, 2160), Some((2560, 1440)), (2560, 1440)),
            ((3840, 2160), Some((3840, 2160)), (3840, 2160)),
            ((5120, 2160), Some((1920, 1080)), (2560, 1080)),
            ((2160, 3840), Some((1920, 1080)), (1920, 3414)),
            ((1280, 720), Some((1920, 1080)), (1280, 720)),
            ((3840, 2160), Some((0, 0)), (1920, 1080)),
            // Encoder dimensions remain fixed when the capture target changes aspect.
            ((4096, 2160), Some((2560, 1440)), (2731, 1440)),
        ] {
            assert_eq!(conversion_size(source, requested), expected);
        }
    }

    fn patterned_input(
        gpu: &Gpu,
        size: (u32, u32),
        pixels: &[[u16; 4]],
        direct: bool,
    ) -> ID3D11Texture2D {
        let mut texture = None;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: if direct {
                D3D11_BIND_SHADER_RESOURCE.0 as u32
            } else {
                0
            },
            ..Default::default()
        };
        assert_eq!(pixels.len(), (size.0 * size.1) as usize);
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: size.0 * 8,
            ..Default::default()
        };
        // SAFETY: The initialized FP16 pixel array covers every texture row.
        unsafe {
            gpu.device
                .CreateTexture2D(&desc, Some(&data), Some(&mut texture))
                .unwrap();
        }
        texture.unwrap()
    }

    fn reference(value: f32, white: f32, hdr: bool) -> u8 {
        let mut value = (value / white).max(0.0);
        if hdr && value > 0.75 {
            value = 0.75 + 0.25 * (value - 0.75) / (value - 0.5);
        }
        let srgb = if value <= 0.0031308 {
            value * 12.92
        } else {
            1.055 * value.powf(1.0 / 2.4) - 0.055
        };
        (srgb.clamp(0.0, 1.0) * 255.0).round() as u8
    }

    #[test]
    fn gpu_direct_and_copy_match_filtered_reference() {
        let gpu = Gpu::create().unwrap();
        let requested = Arc::new(OnceLock::new());
        let mut converter = SdrConverter::new(&gpu, Some(requested.clone())).unwrap();
        converter.refresh = Instant::now() + Duration::from_secs(3600);
        converter.white = 3.0;
        converter.hdr = true;
        let monitor = HMONITOR::default();
        // Include fractional footprints and odd dimensions, not just an aligned 2:1 reduction.
        for size in [(3840, 2160), (4800, 2700), (3841, 2161)] {
            requested.get_or_init(|| (1920, 1080));
            let target = conversion_size(size, Some((1920, 1080)));
            for pattern in 0..7 {
                let value = |x: u32| -> (u16, f32) {
                    match pattern {
                        0 => (0x3800, 0.5),
                        1 | 6 => (0x3c00 + (x % 1024) as u16, 1.0 + (x % 1024) as f32 / 1024.0),
                        2 | 5 => {
                            if x == 101 {
                                (0x3c00, 1.0)
                            } else {
                                (0, 0.0)
                            }
                        }
                        3 => (0x4200, 3.0),
                        _ => (0x4a00, 12.0),
                    }
                };
                let row: Vec<[u16; 4]> = (0..size.0)
                    .map(|x| {
                        let bits = value(x).0;
                        [bits, bits, bits, 0x3c00]
                    })
                    .collect();
                let pixels: Vec<_> = if pattern < 5 {
                    (0..size.1).flat_map(|_| row.iter().copied()).collect()
                } else {
                    (0..size.1)
                        .flat_map(|y| {
                            let bits = value(y).0;
                            std::iter::repeat_n([bits, bits, bits, 0x3c00], size.0 as usize)
                        })
                        .collect()
                };
                let mut copied = Vec::new();
                for direct in [true, false] {
                    let source = patterned_input(&gpu, size, &pixels, direct);
                    let output = converter.convert(&source, monitor).unwrap();
                    let actual = read_all(&gpu, &output);
                    assert_eq!(actual.len(), (target.0 * target.1) as usize);
                    assert_eq!(converter.sources.last().unwrap().1.is_some(), direct);
                    // Reusing a pool texture must reuse its cached view (including a cached copy fallback).
                    let count = converter.sources.len();
                    converter.convert(&source, monitor).unwrap();
                    assert_eq!(converter.sources.len(), count);
                    if pattern == 0 && direct {
                        assert!(
                            converter.input.is_none(),
                            "Direct sampling must not allocate a copy texture"
                        );
                    }
                    if !direct {
                        assert_eq!(
                            actual, copied,
                            "direct/copy mismatch: {size:?}, pattern {pattern}"
                        );
                    } else {
                        copied = actual.clone();
                    }
                    let footprint = if pattern < 5 {
                        size.0 as f64 / target.0 as f64
                    } else {
                        size.1 as f64 / target.1 as f64
                    };
                    for x in 0..target.0 {
                        for y in [0, 50, 51, 52, target.1 / 2, target.1 - 1] {
                            // Independent CPU area integration of piecewise-constant source pixels.
                            let axis = if pattern < 5 { x } else { y };
                            let limit = if pattern < 5 { size.0 } else { size.1 };
                            let left = axis as f64 * footprint;
                            let right = left + footprint;
                            let mut sum = 0.0;
                            for sx in left.floor() as u32..right.ceil() as u32 {
                                let weight =
                                    (right.min(sx as f64 + 1.0) - left.max(sx as f64)).max(0.0);
                                sum += value(sx.min(limit - 1)).1 as f64 * weight;
                            }
                            let expected = reference((sum / footprint) as f32, 3.0, true);
                            let tolerance = 2;
                            let pixel = actual[(y * target.0 + x) as usize];
                            assert!(
                                pixel[0].abs_diff(expected) <= tolerance,
                                "{size:?} pattern {pattern} ({x}, {y}): {pixel:?} != {expected}"
                            );
                            assert_eq!(pixel[0], pixel[1]);
                            assert_eq!(pixel[1], pixel[2]);
                            assert_eq!(pixel[3], 255);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn gpu_scrgb_preserves_sdr_and_normalizes_hdr_white() {
        let gpu = Gpu::create().unwrap();
        let mut converter = SdrConverter::new(&gpu, None).unwrap();
        // Isolate shader math from this machine's HDR settings.
        converter.refresh = Instant::now() + Duration::from_secs(60);
        let monitor = HMONITOR::default();
        for (rgb, expected) in [
            ([0.0, 0.0, 0.0, 1.0], [0, 0, 0, 255]),
            ([0.21404, 0.5, 1.0, 1.0], [255, 188, 128, 255]),
            ([0.0031308, 0.0, 0.0, 1.0], [0, 0, 10, 255]),
        ] {
            let source = input(&gpu, (2, 2), rgb);
            let output = converter.convert(&source, monitor).unwrap();
            let actual = read(&gpu, &output);
            for (actual, expected) in actual.into_iter().zip(expected) {
                assert!(
                    actual.abs_diff(expected) <= 1,
                    "{rgb:?}: {actual} != {expected}"
                );
            }
            // BGRA input is passed through, with no second gamma conversion.
            assert_eq!(converter.convert(&output, monitor).unwrap(), output);
        }
        converter.white = 3.0;
        converter.hdr = true;
        let source = input(&gpu, (3, 2), [0.21404 * 3.0, 0.0, 0.0, 1.0]);
        let output = converter.convert(&source, monitor).unwrap();
        let actual = read(&gpu, &output);
        assert_eq!(&actual[..2], &[0, 0]);
        assert!(
            actual[2].abs_diff(128) <= 1,
            "HDR SDR-white normalization: {actual:?}"
        );

        let mut last = 0;
        for value in [1.0, 2.0, 4.0] {
            let source = input(&gpu, (2, 2), [value * 3.0; 4]);
            let output = converter.convert(&source, monitor).unwrap();
            let pixel = read(&gpu, &output);
            assert!(
                pixel[0] > last && pixel[0] < 255,
                "HDR highlights clipped: {pixel:?}"
            );
            assert_eq!(pixel[0], pixel[1]);
            assert_eq!(pixel[1], pixel[2]);
            last = pixel[0];
        }
    }
}
