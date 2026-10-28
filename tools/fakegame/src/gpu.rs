use anyhow::{Context, Result};
use std::{fs::File, io::Read, path::Path};
use windows::{
    core::{s, Interface, BOOL, PCSTR},
    Win32::{
        Foundation::{DXGI_STATUS_OCCLUDED, HMODULE, HWND},
        Graphics::{
            Direct3D::{
                Fxc::D3DCompile, D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0,
                D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
            },
            Direct3D11::*,
            Dxgi::{Common::*, *},
        },
    },
};

struct Surface {
    view: ID3D11ShaderResourceView,
    target: ID3D11RenderTargetView,
}

pub struct Gpu {
    context: ID3D11DeviceContext,
    swap: IDXGISwapChain1,
    back: ID3D11RenderTargetView,
    pixel: ID3D11PixelShader,
    load: ID3D11PixelShader,
    frames: Vec<[ID3D11ShaderResourceView; 2]>,
    work: [Surface; 2],
    tearing: bool,
}

impl Gpu {
    pub fn new(hwnd: HWND, raw: &Path, size: (u32, u32), output: (u32, u32)) -> Result<Self> {
        // SAFETY: All COM descriptors and upload buffers live through the synchronous calls;
        // the immediate context and window are used only on this thread.
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
            let device = device.context("Missing D3D11 device")?;
            let context = context.context("Missing D3D11 context")?;
            let dxgi: IDXGIDevice = device.cast()?;
            let adapter = dxgi.GetAdapter()?;
            let desc = adapter.GetDesc()?;
            let name = String::from_utf16_lossy(&desc.Description)
                .trim_end_matches('\0')
                .to_string();
            let driver = adapter.CheckInterfaceSupport(&IDXGIDevice::IID)?;
            eprintln!(
                "GPU: {name}; driver: {}.{}.{}.{}",
                (driver >> 48) & 65535,
                (driver >> 32) & 65535,
                (driver >> 16) & 65535,
                driver & 65535
            );
            let factory: IDXGIFactory2 = adapter.GetParent()?;
            let mut supported = BOOL(0);
            let tearing = factory.cast::<IDXGIFactory5>().is_ok_and(|f| {
                f.CheckFeatureSupport(
                    DXGI_FEATURE_PRESENT_ALLOW_TEARING,
                    (&mut supported as *mut BOOL).cast(),
                    size_of::<BOOL>() as u32,
                )
                .is_ok()
                    && supported.as_bool()
            });
            let swap = factory.CreateSwapChainForHwnd(
                &device,
                hwnd,
                &DXGI_SWAP_CHAIN_DESC1 {
                    Width: output.0,
                    Height: output.1,
                    Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                    BufferCount: 2,
                    SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
                    Flags: if tearing {
                        DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING.0 as u32
                    } else {
                        0
                    },
                    ..Default::default()
                },
                None,
                None,
            )?;
            factory.MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER)?;
            let latency: IDXGIDevice1 = dxgi.cast()?;
            latency.SetMaximumFrameLatency(1)?;
            let back_buffer: ID3D11Texture2D = swap.GetBuffer(0)?;
            let mut back = None;
            device.CreateRenderTargetView(&back_buffer, None, Some(&mut back))?;
            let mut vertex = None;
            device.CreateVertexShader(
                &compile(s!("vertex"), s!("vs_5_0"))?,
                None,
                Some(&mut vertex),
            )?;
            context.VSSetShader(&vertex.context("Missing vertex shader")?, None);
            let mut pixel = None;
            device.CreatePixelShader(
                &compile(s!("pixel"), s!("ps_5_0"))?,
                None,
                Some(&mut pixel),
            )?;
            let mut load = None;
            device.CreatePixelShader(
                &compile(s!("loadPixel"), s!("ps_5_0"))?,
                None,
                Some(&mut load),
            )?;
            let constants = [
                size.0 as f32,
                size.1 as f32,
                output.0 as f32,
                output.1 as f32,
            ];
            let mut buffer = None;
            device.CreateBuffer(
                &D3D11_BUFFER_DESC {
                    ByteWidth: 16,
                    Usage: D3D11_USAGE_IMMUTABLE,
                    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                    ..Default::default()
                },
                Some(&D3D11_SUBRESOURCE_DATA {
                    pSysMem: constants.as_ptr().cast(),
                    ..Default::default()
                }),
                Some(&mut buffer),
            )?;
            context.PSSetConstantBuffers(0, Some(&[buffer]));
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                Width: output.0 as f32,
                Height: output.1 as f32,
                MaxDepth: 1.0,
                ..Default::default()
            }]));
            let work = [surface(&device, output)?, surface(&device, output)?];
            for s in &work {
                context.ClearRenderTargetView(&s.target, &[0.0; 4]);
            }
            let mut input = File::open(raw).context("Open predecoded NV12 file")?;
            let bytes = size.0 as usize * size.1 as usize * 3 / 2;
            let length = input.metadata()?.len();
            anyhow::ensure!(
                length > 0 && length % bytes as u64 == 0,
                "NV12 size does not match dimensions"
            );
            let mut frames = Vec::new();
            let mut frame = vec![0u8; bytes];
            for _ in 0..length / bytes as u64 {
                input.read_exact(&mut frame)?;
                let y = plane(&device, size, DXGI_FORMAT_R8_UNORM, &frame, size.0)?;
                let uv = plane(
                    &device,
                    (size.0 / 2, size.1 / 2),
                    DXGI_FORMAT_R8G8_UNORM,
                    &frame[size.0 as usize * size.1 as usize..],
                    size.0,
                )?;
                frames.push([y, uv]);
            }
            context.Flush();
            eprintln!(
                "Loaded {} frames ({} MiB); tearing: {tearing}",
                frames.len(),
                length / 1048576
            );
            Ok(Self {
                context,
                swap,
                back: back.context("Missing back buffer")?,
                pixel: pixel.context("Missing pixel shader")?,
                load: load.context("Missing load shader")?,
                frames,
                work,
                tearing,
            })
        }
    }

    pub fn draw(&self, time: f64, fps: f64, passes: u32) {
        // SAFETY: Private context, valid views; unbind inputs before binding an overlapping target.
        unsafe {
            self.context
                .PSSetShaderResources(0, Some(&[None, None, None]));
            let mut current = 0;
            self.context
                .ClearRenderTargetView(&self.work[0].target, &[0.0; 4]);
            self.context.PSSetShader(&self.load, None);
            for _ in 0..passes {
                self.context.PSSetShaderResources(2, Some(&[None]));
                self.context
                    .OMSetRenderTargets(Some(&[Some(self.work[1 - current].target.clone())]), None);
                self.context
                    .PSSetShaderResources(2, Some(&[Some(self.work[current].view.clone())]));
                self.context.Draw(3, 0);
                current = 1 - current;
            }
            self.context.PSSetShaderResources(2, Some(&[None]));
            self.context
                .OMSetRenderTargets(Some(&[Some(self.back.clone())]), None);
            let frame = &self.frames[(time * fps) as usize % self.frames.len()];
            self.context.PSSetShaderResources(
                0,
                Some(&[
                    Some(frame[0].clone()),
                    Some(frame[1].clone()),
                    Some(self.work[current].view.clone()),
                ]),
            );
            self.context.PSSetShader(&self.pixel, None);
            self.context.Draw(3, 0);
        }
    }

    pub fn present(&self) -> Result<bool> {
        // SAFETY: Window and swap chain are alive; tearing is used only after capability detection.
        let result = unsafe {
            self.swap.Present(
                0,
                if self.tearing {
                    DXGI_PRESENT_ALLOW_TEARING
                } else {
                    DXGI_PRESENT(0)
                },
            )
        };
        result.ok().context("Present failed")?;
        Ok(result != DXGI_STATUS_OCCLUDED)
    }
}

unsafe fn compile(entry: PCSTR, profile: PCSTR) -> Result<Vec<u8>> {
    let source = include_str!("render.hlsl");
    let mut code = None;
    let mut errors = None;
    let result = D3DCompile(
        source.as_ptr().cast(),
        source.len(),
        s!("fakegame"),
        None,
        None,
        entry,
        profile,
        0,
        0,
        &mut code,
        Some(&mut errors),
    );
    if let Some(errors) = errors {
        eprintln!(
            "{}",
            String::from_utf8_lossy(std::slice::from_raw_parts(
                errors.GetBufferPointer().cast(),
                errors.GetBufferSize()
            ))
        );
    }
    result?;
    let code = code.context("Missing shader bytecode")?;
    Ok(std::slice::from_raw_parts(code.GetBufferPointer().cast(), code.GetBufferSize()).to_vec())
}

unsafe fn plane(
    device: &ID3D11Device,
    size: (u32, u32),
    format: DXGI_FORMAT,
    bytes: &[u8],
    pitch: u32,
) -> Result<ID3D11ShaderResourceView> {
    let mut texture = None;
    device.CreateTexture2D(
        &D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_IMMUTABLE,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..Default::default()
        },
        Some(&D3D11_SUBRESOURCE_DATA {
            pSysMem: bytes.as_ptr().cast(),
            SysMemPitch: pitch,
            ..Default::default()
        }),
        Some(&mut texture),
    )?;
    let mut view = None;
    device.CreateShaderResourceView(&texture.context("Missing plane")?, None, Some(&mut view))?;
    view.context("Missing plane view")
}

unsafe fn surface(device: &ID3D11Device, size: (u32, u32)) -> Result<Surface> {
    let mut texture = None;
    device.CreateTexture2D(
        &D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            ..Default::default()
        },
        None,
        Some(&mut texture),
    )?;
    let texture = texture.context("Missing load texture")?;
    let mut view = None;
    let mut target = None;
    device.CreateShaderResourceView(&texture, None, Some(&mut view))?;
    device.CreateRenderTargetView(&texture, None, Some(&mut target))?;
    Ok(Surface {
        view: view.context("Missing load view")?,
        target: target.context("Missing load target")?,
    })
}
