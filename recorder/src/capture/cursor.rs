use anyhow::{ensure, Context, Result};
use windows::core::{s, Interface};
use windows::Win32::Graphics::Direct3D::{Fxc::D3DCompile, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{
    IDXGIOutputDuplication, IDXGISurface1, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_POINTER_SHAPE_INFO,
};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, HICON, ICONINFO,
};

use crate::gpu::Gpu;

/// Composite cached pointer shapes on the GPU, retaining GDI as a fallback and never modifying the desktop texture.
pub(super) struct CursorOverlay {
    gpu: Gpu,
    surface: Option<(ID3D11Texture2D, IDXGISurface1, u32, u32)>,
    renderer: Option<CursorGpu>,
    position: (i32, i32),
    dda_shape: bool,
    system_cursor: Option<(isize, u32, u32)>,
}

impl CursorOverlay {
    pub(super) fn new(gpu: &Gpu) -> Self {
        Self {
            gpu: gpu.clone(),
            surface: None,
            renderer: match CursorGpu::new(gpu) {
                Ok(renderer) => Some(renderer),
                Err(error) => {
                    eprintln!("Could not initialize GPU cursor; using GDI: {error:#}");
                    None
                }
            },
            position: (0, 0),
            dda_shape: false,
            system_cursor: None,
        }
    }

    pub(super) fn reset(&mut self) {
        if let Some(renderer) = &mut self.renderer {
            renderer.shape = None;
        }
        self.position = (0, 0);
        self.dda_shape = false;
        self.system_cursor = None;
    }

    pub(super) fn update(
        &mut self,
        duplication: &IDXGIOutputDuplication,
        info: &DXGI_OUTDUPL_FRAME_INFO,
    ) {
        if info.LastMouseUpdateTime != 0 {
            // DDA reports physical top-left coordinates, already adjusted for the hotspot and DPI.
            self.position = (
                info.PointerPosition.Position.x,
                info.PointerPosition.Position.y,
            );
        }
        if info.PointerShapeBufferSize != 0 && self.renderer.is_some() {
            let result = (|| {
                let mut bytes = vec![0; info.PointerShapeBufferSize as usize];
                let mut required = 0;
                let mut shape = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
                // SAFETY: Called while this duplication owns a frame, with a buffer sized by its metadata.
                unsafe {
                    duplication.GetFramePointerShape(
                        info.PointerShapeBufferSize,
                        bytes.as_mut_ptr().cast(),
                        &mut required,
                        &mut shape,
                    )?;
                }
                ensure!(
                    required as usize <= bytes.len(),
                    "Invalid pointer shape buffer size"
                );
                self.renderer.as_mut().unwrap().set_shape(
                    &self.gpu,
                    &shape,
                    &bytes[..required as usize],
                )
            })();
            match result {
                Ok(()) => self.dda_shape = true,
                Err(error) => {
                    eprintln!("Could not upload GPU cursor; using GDI: {error:#}");
                    self.renderer = None;
                }
            }
        }
    }

    pub(super) fn draw(
        &mut self,
        source: &ID3D11Texture2D,
        monitor: HMONITOR,
    ) -> Result<ID3D11Texture2D> {
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: The monitor is used only for queries and the sized output struct remains live.
        unsafe {
            GetMonitorInfoW(monitor, &mut info).ok()?;
        }
        ensure!(
            info.rcMonitor.right > info.rcMonitor.left
                && info.rcMonitor.bottom > info.rcMonitor.top,
            "Invalid monitor dimensions"
        );
        let monitor_size = (
            (info.rcMonitor.right - info.rcMonitor.left) as u32,
            (info.rcMonitor.bottom - info.rcMonitor.top) as u32,
        );
        if let Some(renderer) = &mut self.renderer {
            if self.dda_shape && renderer.shape.is_some() {
                match renderer.draw(&self.gpu, source, self.position, monitor_size) {
                    Ok(texture) => return Ok(texture),
                    Err(error) => {
                        eprintln!("Could not composite GPU cursor; using GDI: {error:#}");
                        self.renderer = None;
                    }
                }
            }
        }
        let mut cursor = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: All output structs have their required size and remain live during the calls.
        unsafe {
            GetCursorInfo(&mut cursor)?;
        }
        if cursor.flags != CURSOR_SHOWING {
            return Ok(source.clone());
        }
        if let Some((_, hotspot_x, hotspot_y)) = self
            .system_cursor
            .filter(|(handle, _, _)| *handle == cursor.hCursor.0 as isize)
        {
            let position = (
                cursor.ptScreenPos.x - info.rcMonitor.left - hotspot_x as i32,
                cursor.ptScreenPos.y - info.rcMonitor.top - hotspot_y as i32,
            );
            if let Some(renderer) = &mut self.renderer {
                match renderer.draw(&self.gpu, source, position, monitor_size) {
                    Ok(texture) => return Ok(texture),
                    Err(error) => {
                        eprintln!("Could not composite GPU cursor; using GDI: {error:#}");
                        self.renderer = None;
                    }
                }
            }
        }
        let mut icon = ICONINFO::default();
        // SAFETY: The shared cursor handle remains owned by the system; icon receives owned bitmaps.
        unsafe {
            GetIconInfo(HICON(cursor.hCursor.0), &mut icon)?;
        }
        let x = cursor.ptScreenPos.x - info.rcMonitor.left - icon.xHotspot as i32;
        let y = cursor.ptScreenPos.y - info.rcMonitor.top - icon.yHotspot as i32;
        self.system_cursor = Some((cursor.hCursor.0 as isize, icon.xHotspot, icon.yHotspot));
        let shape = self.renderer.as_ref().map(|_| icon_shape(&icon));
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        let mut bitmap = BITMAP::default();
        // SAFETY: The source is held by the capture callback throughout this call.
        unsafe { source.GetDesc(&mut desc) };
        let scale_x = desc.Width as f64 / (info.rcMonitor.right - info.rcMonitor.left) as f64;
        let scale_y = desc.Height as f64 / (info.rcMonitor.bottom - info.rcMonitor.top) as f64;
        let scaled_x = (x as f64 * scale_x).round() as i32;
        let scaled_y = (y as f64 * scale_y).round() as i32;
        let size = if (desc.Width, desc.Height)
            == (
                (info.rcMonitor.right - info.rcMonitor.left) as u32,
                (info.rcMonitor.bottom - info.rcMonitor.top) as u32,
            ) {
            (0, 0)
        } else {
            // SAFETY: GetIconInfo's bitmaps remain live until the DeleteObject calls below.
            unsafe {
                let handle = if icon.hbmColor.is_invalid() {
                    icon.hbmMask
                } else {
                    icon.hbmColor
                };
                GetObjectW(
                    handle.into(),
                    size_of::<BITMAP>() as i32,
                    Some((&mut bitmap as *mut BITMAP).cast()),
                );
            }
            let height = bitmap.bmHeight / if icon.hbmColor.is_invalid() { 2 } else { 1 };
            (
                ((bitmap.bmWidth as f64 * scale_x).round() as i32).max(1),
                ((height as f64 * scale_y).round() as i32).max(1),
            )
        };
        // SAFETY: GetIconInfo allocated these bitmaps; decoding is complete and DrawIconEx uses the cursor handle.
        unsafe {
            if !icon.hbmMask.is_invalid() {
                let _ = DeleteObject(icon.hbmMask.into());
            }
            if !icon.hbmColor.is_invalid() {
                let _ = DeleteObject(icon.hbmColor.into());
            }
        }
        if let Some(shape) = shape {
            self.position = (x, y);
            let result = shape.and_then(|shape| {
                let renderer = self.renderer.as_mut().unwrap();
                renderer.upload_shape(&self.gpu, shape)?;
                renderer.draw(&self.gpu, source, (x, y), monitor_size)
            });
            match result {
                Ok(texture) => return Ok(texture),
                Err(error) => {
                    eprintln!("Could not initialize cursor shape; using GDI: {error:#}");
                    self.renderer = None;
                }
            }
        }
        ensure!(
            size == (0, 0) || bitmap.bmWidth > 0 && bitmap.bmHeight > 0,
            "Could not query cursor dimensions"
        );
        self.draw_icon(source, HICON(cursor.hCursor.0), scaled_x, scaled_y, size)
    }

    fn draw_icon(
        &mut self,
        source: &ID3D11Texture2D,
        icon: HICON,
        x: i32,
        y: i32,
        size: (i32, i32),
    ) -> Result<ID3D11Texture2D> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: source remains alive throughout this draw.
        unsafe {
            source.GetDesc(&mut desc);
        }
        if self
            .surface
            .as_ref()
            .is_none_or(|s| (s.2, s.3) != (desc.Width, desc.Height))
        {
            desc.Usage = D3D11_USAGE_DEFAULT;
            desc.BindFlags = D3D11_BIND_RENDER_TARGET.0 as u32;
            desc.CPUAccessFlags = 0;
            desc.MiscFlags = D3D11_RESOURCE_MISC_GDI_COMPATIBLE.0 as u32;
            let mut texture = None;
            // SAFETY: The private GDI-compatible texture matches the source dimensions and format.
            unsafe {
                self.gpu
                    .device
                    .CreateTexture2D(&desc, None, Some(&mut texture))?;
            }
            let texture = texture.context("Missing cursor surface")?;
            let surface = texture.cast()?;
            self.surface = Some((texture, surface, desc.Width, desc.Height));
        }
        let (texture, surface, _, _) = self.surface.as_ref().unwrap();
        // SAFETY: The private surface is not used by D3D until ReleaseDC, including when drawing fails.
        unsafe {
            self.gpu.context.CopyResource(texture, source);
            let dc = surface.GetDC(false)?;
            let drawn = DrawIconEx(dc, x, y, icon, size.0, size.1, 0, None, DI_NORMAL);
            surface.ReleaseDC(None)?;
            drawn?;
        }
        Ok(texture.clone())
    }
}

struct PointerShape {
    size: (u32, u32),
    kind: u32,
    pixels: Vec<[u8; 4]>,
}

fn pointer_shape(info: &DXGI_OUTDUPL_POINTER_SHAPE_INFO, bytes: &[u8]) -> Result<PointerShape> {
    ensure!(
        [1, 2, 4].contains(&info.Type),
        "Unsupported pointer shape type"
    );
    let mono = info.Type == 1;
    ensure!(
        info.Width > 0 && info.Height > 0 && (!mono || info.Height.is_multiple_of(2)),
        "Invalid pointer dimensions"
    );
    let height = if mono { info.Height / 2 } else { info.Height };
    let row = if mono {
        (info.Width as usize).div_ceil(8)
    } else {
        info.Width as usize * 4
    };
    ensure!(
        info.Pitch as usize >= row
            && (info.Pitch as usize)
                .checked_mul(info.Height as usize)
                .is_some_and(|size| size <= bytes.len()),
        "Truncated pointer shape"
    );
    let mut pixels = Vec::with_capacity(info.Width as usize * height as usize);
    for y in 0..height as usize {
        for x in 0..info.Width as usize {
            let offset = y * info.Pitch as usize;
            let pixel = if mono {
                let bit = 0x80 >> (x % 8);
                let and = if bytes[offset + x / 8] & bit != 0 {
                    255
                } else {
                    0
                };
                let xor =
                    if bytes[offset + height as usize * info.Pitch as usize + x / 8] & bit != 0 {
                        255
                    } else {
                        0
                    };
                [xor, xor, xor, and]
            } else {
                let p = &bytes[offset + x * 4..offset + x * 4 + 4];
                ensure!(
                    info.Type != 4 || p[3] == 0 || p[3] == 255,
                    "Invalid masked cursor alpha"
                );
                [p[2], p[1], p[0], p[3]]
            };
            pixels.push(pixel);
        }
    }
    Ok(PointerShape {
        size: (info.Width, height),
        kind: info.Type,
        pixels,
    })
}

struct BitmapPixels {
    size: (u32, u32),
    pixels: Vec<[u8; 4]>,
}

fn bitmap_pixels(bitmap: HBITMAP) -> Result<BitmapPixels> {
    let mut desc = BITMAP::default();
    // SAFETY: The bitmap is owned by ICONINFO; GetObject writes only to the supplied descriptor.
    unsafe {
        ensure!(
            GetObjectW(
                bitmap.into(),
                size_of::<BITMAP>() as i32,
                Some((&mut desc as *mut BITMAP).cast())
            ) != 0,
            "Could not query cursor bitmap"
        );
    }
    ensure!(
        desc.bmWidth > 0 && desc.bmHeight > 0,
        "Invalid cursor bitmap dimensions"
    );
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: desc.bmWidth,
            biHeight: -desc.bmHeight,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![[0u8; 4]; desc.bmWidth as usize * desc.bmHeight as usize];
    // SAFETY: The CPU DC is used only to decode the unselected icon bitmap and is always deleted.
    let rows = unsafe {
        let dc = CreateCompatibleDC(None);
        ensure!(!dc.is_invalid(), "Could not create cursor bitmap DC");
        let rows = GetDIBits(
            dc,
            bitmap,
            0,
            desc.bmHeight as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        rows
    };
    ensure!(rows == desc.bmHeight, "Could not read cursor bitmap");
    for p in &mut pixels {
        p.swap(0, 2);
    }
    Ok(BitmapPixels {
        size: (desc.bmWidth as u32, desc.bmHeight as u32),
        pixels,
    })
}

fn icon_shape(icon: &ICONINFO) -> Result<PointerShape> {
    let BitmapPixels {
        size: mask_size,
        pixels: mask,
    } = bitmap_pixels(icon.hbmMask)?;
    if icon.hbmColor.is_invalid() {
        ensure!(
            mask_size.1.is_multiple_of(2),
            "Invalid monochrome icon height"
        );
        let size = (mask_size.0, mask_size.1 / 2);
        let plane = size.0 as usize * size.1 as usize;
        let pixels = mask[..plane]
            .iter()
            .zip(&mask[plane..])
            .map(|(and, xor)| [xor[0], xor[1], xor[2], and[0]])
            .collect();
        return Ok(PointerShape {
            size,
            kind: 1,
            pixels,
        });
    }
    let BitmapPixels { size, mut pixels } = bitmap_pixels(icon.hbmColor)?;
    ensure!(mask_size == size, "Cursor mask size mismatch");
    let alpha = pixels.iter().any(|p| p[3] != 0);
    if !alpha {
        for (p, mask) in pixels.iter_mut().zip(mask) {
            p[3] = mask[0];
        }
    }
    // Legacy icons retain their AND/XOR mask when no alpha channel is present.
    Ok(PointerShape {
        size,
        kind: if alpha { 2 } else { 1 },
        pixels,
    })
}

struct ShapeTextures {
    size: (u32, u32),
    kind: u32,
    pointer: ID3D11ShaderResourceView,
    background: ID3D11Texture2D,
    background_view: ID3D11ShaderResourceView,
}

struct CursorGpu {
    context: ID3D11DeviceContext,
    vertex: ID3D11VertexShader,
    pixel: ID3D11PixelShader,
    constants: ID3D11Buffer,
    sampler: ID3D11SamplerState,
    shape: Option<ShapeTextures>,
    output: Option<(ID3D11Texture2D, ID3D11RenderTargetView, u32, u32)>,
}

impl CursorGpu {
    fn new(gpu: &Gpu) -> Result<Self> {
        let mut vertex = None;
        let mut pixel = None;
        let mut constants = None;
        let mut sampler = None;
        let mut context = None;
        // SAFETY: Source, compiled bytecode and descriptors remain valid during each synchronous call.
        unsafe {
            for (is_vertex, entry, profile) in [
                (true, s!("vertex"), s!("vs_5_0")),
                (false, s!("pixel"), s!("ps_5_0")),
            ] {
                let source = include_str!("cursor.hlsl");
                let mut code = None;
                let mut errors = None;
                D3DCompile(
                    source.as_ptr().cast(),
                    source.len(),
                    s!("aditorrec-cursor"),
                    None,
                    None,
                    entry,
                    profile,
                    0,
                    0,
                    &mut code,
                    Some(&mut errors),
                )
                .context("Failed to compile cursor shader")?;
                let code = code.context("Missing cursor bytecode")?;
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
                    ByteWidth: 32,
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut constants),
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
            context: context.context("Missing cursor context")?,
            vertex: vertex.context("Missing cursor vertex shader")?,
            pixel: pixel.context("Missing cursor pixel shader")?,
            constants: constants.context("Missing cursor constants")?,
            sampler: sampler.context("Missing cursor sampler")?,
            shape: None,
            output: None,
        })
    }

    fn set_shape(
        &mut self,
        gpu: &Gpu,
        info: &DXGI_OUTDUPL_POINTER_SHAPE_INFO,
        bytes: &[u8],
    ) -> Result<()> {
        self.upload_shape(gpu, pointer_shape(info, bytes)?)
    }

    fn upload_shape(&mut self, gpu: &Gpu, shape: PointerShape) -> Result<()> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: shape.size.0,
            Height: shape.size.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_IMMUTABLE,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..Default::default()
        };
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: shape.pixels.as_ptr().cast(),
            SysMemPitch: shape.size.0 * 4,
            ..Default::default()
        };
        let mut pointer = None;
        let mut pointer_view = None;
        let mut background = None;
        let mut background_view = None;
        // SAFETY: Converted pixels cover the entire shape; each view references its same-device texture.
        unsafe {
            gpu.device
                .CreateTexture2D(&desc, Some(&data), Some(&mut pointer))?;
            gpu.device.CreateShaderResourceView(
                &pointer.context("Missing pointer texture")?,
                None,
                Some(&mut pointer_view),
            )?;
            gpu.device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    Usage: D3D11_USAGE_DEFAULT,
                    ..desc
                },
                None,
                Some(&mut background),
            )?;
            gpu.device.CreateShaderResourceView(
                background.as_ref().context("Missing cursor background")?,
                None,
                Some(&mut background_view),
            )?;
        }
        self.shape = Some(ShapeTextures {
            size: shape.size,
            kind: shape.kind,
            pointer: pointer_view.context("Missing pointer view")?,
            background: background.context("Missing cursor background")?,
            background_view: background_view.context("Missing cursor background view")?,
        });
        Ok(())
    }

    fn draw(
        &mut self,
        gpu: &Gpu,
        source: &ID3D11Texture2D,
        position: (i32, i32),
        monitor_size: (u32, u32),
    ) -> Result<ID3D11Texture2D> {
        let shape = self.shape.as_mut().context("Missing pointer shape")?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: source remains owned by the caller throughout command submission.
        unsafe {
            source.GetDesc(&mut desc);
        }
        ensure!(
            desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM && desc.SampleDesc.Count == 1,
            "Unsupported cursor destination format"
        );
        ensure!(
            monitor_size.0 > 0 && monitor_size.1 > 0,
            "Invalid monitor dimensions"
        );
        let scale_x = desc.Width as f64 / monitor_size.0 as f64;
        let scale_y = desc.Height as f64 / monitor_size.1 as f64;
        let x = (position.0 as f64 * scale_x).round() as i32;
        let y = (position.1 as f64 * scale_y).round() as i32;
        let size = (
            ((shape.size.0 as f64 * scale_x).round() as u32).max(1),
            ((shape.size.1 as f64 * scale_y).round() as u32).max(1),
        );
        let left = i64::from(x).max(0).min(i64::from(desc.Width)) as u32;
        let top = i64::from(y).max(0).min(i64::from(desc.Height)) as u32;
        let right = (i64::from(x) + i64::from(size.0)).clamp(0, i64::from(desc.Width)) as u32;
        let bottom = (i64::from(y) + i64::from(size.1)).clamp(0, i64::from(desc.Height)) as u32;
        if right <= left || bottom <= top {
            return Ok(source.clone());
        }
        if self
            .output
            .as_ref()
            .is_none_or(|s| (s.2, s.3) != (desc.Width, desc.Height))
        {
            let mut texture = None;
            let mut target = None;
            let desc = D3D11_TEXTURE2D_DESC {
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
                ..desc
            };
            // SAFETY: The output is a private single-sample BGRA texture and render target.
            unsafe {
                gpu.device
                    .CreateTexture2D(&desc, None, Some(&mut texture))?;
                gpu.device.CreateRenderTargetView(
                    texture.as_ref().context("Missing cursor output")?,
                    None,
                    Some(&mut target),
                )?;
            }
            self.output = Some((
                texture.context("Missing cursor output")?,
                target.context("Missing cursor target")?,
                desc.Width,
                desc.Height,
            ));
        }
        let mut background_desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: The cached background is owned by the shape and resized only between draws.
        unsafe { shape.background.GetDesc(&mut background_desc) };
        if (background_desc.Width, background_desc.Height) != size {
            let mut background = None;
            let mut view = None;
            // SAFETY: The private background covers the scaled cursor's destination pixels.
            unsafe {
                gpu.device.CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: size.0,
                        Height: size.1,
                        ..background_desc
                    },
                    None,
                    Some(&mut background),
                )?;
                gpu.device.CreateShaderResourceView(
                    background.as_ref().context("Missing cursor background")?,
                    None,
                    Some(&mut view),
                )?;
            }
            shape.background = background.context("Missing cursor background")?;
            shape.background_view = view.context("Missing cursor background view")?;
        }
        let (texture, target, _, _) = self.output.as_ref().unwrap();
        let constants = [
            x as u32,
            y as u32,
            shape.kind,
            0,
            (shape.size.0 as f32).to_bits(),
            (shape.size.1 as f32).to_bits(),
            (size.0 as f32).to_bits(),
            (size.1 as f32).to_bits(),
        ];
        let region = D3D11_BOX {
            left,
            top,
            front: 0,
            right,
            bottom,
            back: 1,
        };
        let mut commands = None;
        // SAFETY: Private deferred state submits atomically; only the clipped cursor region is read for blending/XOR.
        unsafe {
            self.context.CopyResource(texture, source);
            self.context.CopySubresourceRegion(
                &shape.background,
                0,
                (i64::from(left) - i64::from(x)) as u32,
                (i64::from(top) - i64::from(y)) as u32,
                0,
                source,
                0,
                Some(&region),
            );
            self.context.UpdateSubresource(
                &self.constants,
                0,
                None,
                constants.as_ptr().cast(),
                0,
                0,
            );
            self.context
                .IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.VSSetShader(&self.vertex, None);
            self.context.PSSetShader(&self.pixel, None);
            self.context
                .PSSetConstantBuffers(0, Some(&[Some(self.constants.clone())]));
            self.context
                .PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.context.PSSetShaderResources(
                0,
                Some(&[
                    Some(shape.pointer.clone()),
                    Some(shape.background_view.clone()),
                ]),
            );
            self.context
                .OMSetRenderTargets(Some(&[Some(target.clone())]), None);
            self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: x as f32,
                TopLeftY: y as f32,
                Width: size.0 as f32,
                Height: size.1 as f32,
                MaxDepth: 1.0,
                ..Default::default()
            }]));
            self.context.Draw(3, 0);
            self.context.FinishCommandList(false, Some(&mut commands))?;
            gpu.context
                .ExecuteCommandList(&commands.context("Missing cursor commands")?, true);
        }
        Ok(texture.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Direct3D11::D3D11_SUBRESOURCE_DATA;
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Gdi::GetPixel;
    use windows::Win32::UI::WindowsAndMessaging::{LoadCursorW, IDC_ARROW};

    fn blend(kind: u32, cursor: [u8; 4], dest: [u8; 4]) -> [u8; 4] {
        let mut result = dest;
        for i in 0..3 {
            result[i] = match kind {
                1 => (dest[i] & cursor[3]) ^ cursor[i],
                4 if cursor[3] == 255 => dest[i] ^ cursor[i],
                4 => cursor[i],
                2 => {
                    ((u32::from(cursor[i]) * u32::from(cursor[3])
                        + u32::from(dest[i]) * (255 - u32::from(cursor[3]))
                        + 127)
                        / 255) as u8
                }
                _ => panic!("Unknown pointer type"),
            };
        }
        result
    }

    #[test]
    fn converts_pitched_color_and_both_monochrome_planes() {
        let info = DXGI_OUTDUPL_POINTER_SHAPE_INFO {
            Type: 2,
            Width: 1,
            Height: 2,
            Pitch: 8,
            ..Default::default()
        };
        let bytes = [
            10, 20, 30, 128, 99, 99, 99, 99, 40, 50, 60, 255, 99, 99, 99, 99,
        ];
        assert_eq!(
            pointer_shape(&info, &bytes).unwrap().pixels,
            [[30, 20, 10, 128], [60, 50, 40, 255]]
        );
        assert!(pointer_shape(&info, &bytes[..15]).is_err());
        let mono = DXGI_OUTDUPL_POINTER_SHAPE_INFO {
            Type: 1,
            Width: 4,
            Height: 2,
            Pitch: 2,
            ..Default::default()
        };
        let shape = pointer_shape(&mono, &[0b00110000, 0, 0b01010000, 0]).unwrap();
        assert_eq!(shape.size, (4, 1));
        assert_eq!(
            shape.pixels,
            [
                [0, 0, 0, 0],
                [255, 255, 255, 0],
                [0, 0, 0, 255],
                [255, 255, 255, 255]
            ]
        );
        assert!(pointer_shape(
            &DXGI_OUTDUPL_POINTER_SHAPE_INFO { Height: 3, ..mono },
            &[0; 6]
        )
        .is_err());
        assert!(pointer_shape(&DXGI_OUTDUPL_POINTER_SHAPE_INFO { Pitch: 0, ..mono }, &[]).is_err());
        assert!(
            pointer_shape(&DXGI_OUTDUPL_POINTER_SHAPE_INFO { Type: 4, ..info }, &bytes).is_err()
        );
    }

    #[test]
    fn cursor_blend_preserves_alpha_and_all_mask_operations() {
        let dest = [0x12, 0x34, 0x56, 255];
        assert_eq!(blend(1, [0; 4], dest), [0, 0, 0, 255]);
        assert_eq!(blend(1, [255, 255, 255, 0], dest), [255; 4]);
        assert_eq!(blend(1, [0, 0, 0, 255], dest), dest);
        assert_eq!(blend(1, [255; 4], dest), [0xed, 0xcb, 0xa9, 255]);
        assert_eq!(
            blend(4, [0xf0, 0x0f, 0xff, 0], dest),
            [0xf0, 0x0f, 0xff, 255]
        );
        assert_eq!(
            blend(4, [0xf0, 0x0f, 0xff, 255], dest),
            [0xe2, 0x3b, 0xa9, 255]
        );
        assert_eq!(blend(2, [200, 100, 0, 0], dest), dest);
        assert_eq!(blend(2, [200, 100, 0, 255], dest), [200, 100, 0, 255]);
        assert_eq!(blend(2, [200, 100, 0, 128], dest), [109, 76, 43, 255]);
    }

    fn read_pixels(gpu: &Gpu, texture: &ID3D11Texture2D) -> Vec<[u8; 4]> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        let mut staging = None;
        // SAFETY: Staging matches the source; mapped rows are read only within their dimensions and then unmapped.
        unsafe {
            texture.GetDesc(&mut desc);
            gpu.device
                .CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Usage: D3D11_USAGE_STAGING,
                        BindFlags: 0,
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        MiscFlags: 0,
                        ..desc
                    },
                    None,
                    Some(&mut staging),
                )
                .unwrap();
            let staging = staging.unwrap();
            gpu.context.CopyResource(&staging, texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            gpu.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .unwrap();
            let mut pixels = Vec::new();
            for y in 0..desc.Height as usize {
                let row = std::slice::from_raw_parts(
                    mapped.pData.cast::<u8>().add(y * mapped.RowPitch as usize),
                    desc.Width as usize * 4,
                );
                pixels.extend(row.chunks_exact(4).map(|p| [p[2], p[1], p[0], p[3]]));
            }
            gpu.context.Unmap(&staging, 0);
            pixels
        }
    }

    #[test]
    fn gpu_cursor_matches_blend_math_clips_and_has_no_trails() {
        let gpu = Gpu::create().unwrap();
        let background = [0x12, 0x34, 0x56, 255];
        let pixels = [0xff123456u32; 8 * 4];
        let desc = D3D11_TEXTURE2D_DESC {
            Width: 8,
            Height: 4,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            ..Default::default()
        };
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: 32,
            ..Default::default()
        };
        let mut source = None;
        // SAFETY: Initial pixels cover all four texture rows.
        unsafe {
            gpu.device
                .CreateTexture2D(&desc, Some(&data), Some(&mut source))
                .unwrap();
        }
        let source = source.unwrap();
        let mut renderer = CursorGpu::new(&gpu).unwrap();
        for (kind, height, pitch, bytes) in [
            (1, 2, 1, vec![0b00110000, 0b01010000]),
            (
                2,
                1,
                16,
                vec![
                    0, 0, 200, 0, 0, 100, 200, 128, 0, 100, 200, 255, 99, 55, 22, 255,
                ],
            ),
            (
                4,
                1,
                16,
                vec![
                    0xff, 0x0f, 0xf0, 0, 0xff, 0x0f, 0xf0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
                ],
            ),
        ] {
            let info = DXGI_OUTDUPL_POINTER_SHAPE_INFO {
                Type: kind,
                Width: 4,
                Height: height,
                Pitch: pitch,
                ..Default::default()
            };
            let shape = pointer_shape(&info, &bytes).unwrap();
            renderer.set_shape(&gpu, &info, &bytes).unwrap();
            let view = renderer.shape.as_ref().unwrap().pointer.clone();
            for (x, y) in [(2, 1), (-2, 0), (6, 3), (0, -1), (20, 20)] {
                let output = renderer.draw(&gpu, &source, (x, y), (8, 4)).unwrap();
                let actual = read_pixels(&gpu, &output);
                let mut expected = vec![background; 32];
                for (i, pixel) in shape.pixels.iter().enumerate() {
                    let px = x + i as i32;
                    if (0..8).contains(&px) && (0..4).contains(&y) {
                        expected[(y * 8 + px) as usize] = blend(kind, *pixel, background);
                    }
                }
                assert_eq!(actual, expected, "kind {kind}, position {x},{y}");
                assert_eq!(
                    renderer.shape.as_ref().unwrap().pointer,
                    view,
                    "position changes must not upload the shape"
                );
            }
        }
        for (kind, row, sampled) in [
            (
                1,
                [[0, 0, 0, 0], [255, 255, 255, 0], [0, 0, 0, 255], [255; 4]],
                [[255, 255, 255, 0], [255; 4]],
            ),
            (
                4,
                [
                    [0, 0, 0, 0],
                    [0xf0, 0x0f, 0xff, 255],
                    [255; 4],
                    [10, 20, 30, 0],
                ],
                [[0xf0, 0x0f, 0xff, 255], [10, 20, 30, 0]],
            ),
            (
                2,
                [[0; 4], [200, 100, 0, 128], [0; 4], [0, 100, 200, 128]],
                [[100, 50, 0, 64], [0, 50, 100, 64]],
            ),
        ] {
            renderer
                .upload_shape(
                    &gpu,
                    PointerShape {
                        size: (4, 8),
                        kind,
                        pixels: row.repeat(8),
                    },
                )
                .unwrap();
            let view = renderer.shape.as_ref().unwrap().pointer.clone();
            // Nonuniform scaling halves X and quarters Y, including negative top-left coordinates.
            for (position, origin) in [((4, 4), (2, 1)), ((-2, -4), (-1, -1)), ((14, 12), (7, 3))] {
                let output = renderer.draw(&gpu, &source, position, (16, 16)).unwrap();
                let actual = read_pixels(&gpu, &output);
                let mut expected = vec![background; 32];
                for y in 0..2 {
                    for (x, pixel) in sampled.iter().enumerate() {
                        let px = origin.0 + x as i32;
                        let py = origin.1 + y;
                        if (0..8).contains(&px) && (0..4).contains(&py) {
                            expected[(py * 8 + px) as usize] = blend(kind, *pixel, background);
                        }
                    }
                }
                for (a, e) in actual.iter().zip(expected) {
                    for channel in 0..4 {
                        assert!(
                            a[channel].abs_diff(e[channel]) <= 1,
                            "Scaled kind {kind}, position {position:?}: {a:?} vs {e:?}"
                        );
                    }
                }
                assert_eq!(renderer.shape.as_ref().unwrap().pointer, view);
            }
            // A destination-size change must resize the background without reuploading the pointer.
            let output = renderer.draw(&gpu, &source, (0, 0), (8, 4)).unwrap();
            assert_eq!(
                read_pixels(&gpu, &output)[0],
                blend(kind, row[0], background)
            );
            assert_eq!(renderer.shape.as_ref().unwrap().pointer, view);
        }
        assert_eq!(read_pixels(&gpu, &source), vec![background; 32]);
    }

    #[test]
    fn win32_shapes_use_gpu_when_duplication_has_no_shape() {
        use windows::Win32::UI::WindowsAndMessaging::{IDC_CROSS, IDC_IBEAM};
        let gpu = Gpu::create().unwrap();
        let pixels = vec![0xff123456u32; 128 * 128];
        let desc = D3D11_TEXTURE2D_DESC {
            Width: 128,
            Height: 128,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            ..Default::default()
        };
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: 128 * 4,
            ..Default::default()
        };
        let mut source = None;
        // SAFETY: Pixels cover the source; icon bitmaps are freed after decoding, before any GPU work.
        unsafe {
            gpu.device
                .CreateTexture2D(&desc, Some(&data), Some(&mut source))
                .unwrap();
        }
        let source = source.unwrap();
        let mut renderer = CursorGpu::new(&gpu).unwrap();
        for id in [IDC_ARROW, IDC_IBEAM, IDC_CROSS] {
            let mut icon = ICONINFO::default();
            // SAFETY: These shared system cursor handles are queried but never destroyed.
            let handle = unsafe { HICON(LoadCursorW(None, id).unwrap().0) };
            // SAFETY: The handle is shared; only the newly allocated ICONINFO bitmaps are later deleted.
            unsafe {
                GetIconInfo(handle, &mut icon).unwrap();
            }
            let shape = icon_shape(&icon);
            // SAFETY: Decoding finished, so the owned icon bitmaps can be deleted.
            unsafe {
                if !icon.hbmMask.is_invalid() {
                    let _ = DeleteObject(icon.hbmMask.into());
                }
                if !icon.hbmColor.is_invalid() {
                    let _ = DeleteObject(icon.hbmColor.into());
                }
            }
            let shape = shape.unwrap();
            let mut expected = vec![[0x12, 0x34, 0x56, 255]; 128 * 128];
            for (index, pixel) in shape.pixels.iter().enumerate() {
                let x = 8 + index % shape.size.0 as usize;
                let y = 8 + index / shape.size.0 as usize;
                if x < 128 && y < 128 {
                    expected[y * 128 + x] = blend(shape.kind, *pixel, expected[y * 128 + x]);
                }
            }
            renderer.upload_shape(&gpu, shape).unwrap();
            let drawn = renderer.draw(&gpu, &source, (8, 8), (128, 128)).unwrap();
            let actual = read_pixels(&gpu, &drawn);
            for (a, e) in actual.iter().zip(expected) {
                for channel in 0..4 {
                    assert!(
                        a[channel].abs_diff(e[channel]) <= 1,
                        "Win32 cursor differs from blend: {a:?} vs {e:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn gpu_cursor_is_drawn_on_a_reusable_copy_and_leaves_no_trail() {
        let gpu = Gpu::create().unwrap();
        let pixels = vec![0xff000000u32; 64 * 64];
        let desc = D3D11_TEXTURE2D_DESC {
            Width: 64,
            Height: 64,
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
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: 256,
            ..Default::default()
        };
        let mut source = None;
        // SAFETY: Pixel storage covers the entire texture and remains alive throughout initialization.
        unsafe {
            gpu.device
                .CreateTexture2D(&desc, Some(&data), Some(&mut source))
                .unwrap();
        }
        let source = source.unwrap();
        // SAFETY: Loads a shared system cursor which must not be destroyed.
        let icon = HICON(unsafe { LoadCursorW(None, IDC_ARROW).unwrap() }.0);
        let mut overlay = CursorOverlay::new(&gpu);
        let drawn = overlay.draw_icon(&source, icon, 8, 8, (0, 0)).unwrap();
        assert_ne!(drawn, source);
        let surface: IDXGISurface1 = drawn.cast().unwrap();
        // SAFETY: Each DC is released before any further D3D work.
        unsafe {
            let dc = surface.GetDC(false).unwrap();
            let visible = (8..40).any(|y| (8..40).any(|x| GetPixel(dc, x, y).0 != 0));
            surface.ReleaseDC(None).unwrap();
            assert!(visible);
        }
        let scaled = overlay.draw_icon(&source, icon, 8, 8, (8, 8)).unwrap();
        let surface: IDXGISurface1 = scaled.cast().unwrap();
        // SAFETY: Inspect the GDI drawing only while its DC is held.
        unsafe {
            let dc = surface.GetDC(false).unwrap();
            assert!((8..16).any(|y| (8..16).any(|x| GetPixel(dc, x, y).0 != 0)));
            assert!((16..40).all(|y| (16..40).all(|x| GetPixel(dc, x, y).0 == 0)));
            surface.ReleaseDC(None).unwrap();
        }
        let cleared = overlay
            .draw_icon(&source, icon, -100, -100, (0, 0))
            .unwrap();
        assert_eq!(drawn, cleared);
        // SAFETY: The DC is read only and released before any further GPU work.
        unsafe {
            let dc = surface.GetDC(false).unwrap();
            let clean = (8..40).all(|y| (8..40).all(|x| GetPixel(dc, x, y).0 == 0));
            surface.ReleaseDC(None).unwrap();
            assert!(clean);
        }
    }
}
