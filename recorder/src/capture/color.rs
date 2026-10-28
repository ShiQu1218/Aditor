//! Convert linear scRGB capture to SDR before passing it to encoding or analysis.
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
    surfaces: Option<Surfaces>,
    monitor: isize,
    white: f32,
    hdr: bool,
    refresh: Instant,
}

struct Surfaces {
    size: (u32, u32),
    input: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
    output: ID3D11Texture2D,
    target: ID3D11RenderTargetView,
}

impl SdrConverter {
    pub(super) fn new(gpu: &Gpu) -> Result<Self> {
        let mut vertex = None;
        let mut pixel = None;
        let mut levels = None;
        let mut context = None;
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
            gpu.device.CreateDeferredContext(0, Some(&mut context))?;
        }
        Ok(Self {
            gpu: gpu.clone(),
            context: context.context("Missing SDR context")?,
            vertex: vertex.context("Missing SDR vertex shader")?,
            pixel: pixel.context("Missing SDR pixel shader")?,
            levels: levels.context("Missing SDR constants")?,
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
        let size = (desc.Width, desc.Height);
        if self.surfaces.as_ref().is_none_or(|s| s.size != size) {
            self.surfaces = Some(Surfaces::new(&self.gpu, size)?);
        }
        let surfaces = self.surfaces.as_ref().context("Missing SDR surfaces")?;
        let levels = [self.white, if self.hdr { 1.0 } else { 0.0 }, 0.0, 0.0];
        let mut commands = None;
        // SAFETY: This private deferred context owns its state. ExecuteCommandList submits
        // the copy and draw atomically, preserving the shared immediate context's state.
        unsafe {
            self.context.CopyResource(&surfaces.input, source);
            self.context
                .UpdateSubresource(&self.levels, 0, None, levels.as_ptr().cast(), 0, 0);
            self.context
                .IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.VSSetShader(&self.vertex, None);
            self.context.PSSetShader(&self.pixel, None);
            self.context
                .PSSetConstantBuffers(0, Some(&[Some(self.levels.clone())]));
            self.context
                .PSSetShaderResources(0, Some(&[Some(surfaces.view.clone())]));
            self.context
                .OMSetRenderTargets(Some(&[Some(surfaces.target.clone())]), None);
            self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                Width: size.0 as f32,
                Height: size.1 as f32,
                MaxDepth: 1.0,
                ..Default::default()
            }]));
            self.context.Draw(3, 0);
            self.context.FinishCommandList(false, Some(&mut commands))?;
            self.gpu
                .context
                .ExecuteCommandList(&commands.context("Missing SDR commands")?, true);
        }
        Ok(surfaces.output.clone())
    }
}

impl Surfaces {
    fn new(gpu: &Gpu, size: (u32, u32)) -> Result<Self> {
        let mut desc = D3D11_TEXTURE2D_DESC {
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
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..Default::default()
        };
        let (mut input, mut view, mut output, mut target) = (None, None, None, None);
        // SAFETY: Descriptors select a single-mip texture and views on the same device.
        unsafe {
            gpu.device.CreateTexture2D(&desc, None, Some(&mut input))?;
            let input = input.as_ref().context("Missing scRGB input")?;
            gpu.device
                .CreateShaderResourceView(input, None, Some(&mut view))?;
            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
            desc.BindFlags = D3D11_BIND_RENDER_TARGET.0 as u32;
            gpu.device.CreateTexture2D(&desc, None, Some(&mut output))?;
            gpu.device.CreateRenderTargetView(
                output.as_ref().context("Missing SDR output")?,
                None,
                Some(&mut target),
            )?;
        }
        Ok(Self {
            size,
            input: input.context("Missing scRGB input")?,
            view: view.context("Missing scRGB view")?,
            output: output.context("Missing SDR output")?,
            target: target.context("Missing SDR render target")?,
        })
    }
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
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        let mut staging = None;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: Map is balanced by Unmap; copy exactly one BGRA pixel before unmapping.
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
            let pixel = std::ptr::read(mapped.pData.cast::<[u8; 4]>());
            gpu.context.Unmap(&staging, 0);
            pixel
        }
    }

    #[test]
    fn gpu_scrgb_preserves_sdr_and_normalizes_hdr_white() {
        let gpu = Gpu::create().unwrap();
        let mut converter = SdrConverter::new(&gpu).unwrap();
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
