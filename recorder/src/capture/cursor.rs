use anyhow::{Context, Result};
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_RESOURCE_MISC_GDI_COMPATIBLE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::IDXGISurface1;
use windows::Win32::Graphics::Gdi::{DeleteObject, GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, HICON, ICONINFO,
};

use crate::gpu::Gpu;

/// Reuse a GDI-compatible GPU surface; never modify the desktop duplication texture.
pub(super) struct CursorOverlay {
    gpu: Gpu,
    surface: Option<(ID3D11Texture2D, IDXGISurface1, u32, u32)>,
}

impl CursorOverlay {
    pub(super) fn new(gpu: &Gpu) -> Self {
        Self {
            gpu: gpu.clone(),
            surface: None,
        }
    }

    pub(super) fn draw(
        &mut self,
        source: &ID3D11Texture2D,
        monitor: HMONITOR,
    ) -> Result<ID3D11Texture2D> {
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
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        unsafe {
            GetMonitorInfoW(monitor, &mut info).ok()?;
        }
        let mut icon = ICONINFO::default();
        unsafe {
            GetIconInfo(HICON(cursor.hCursor.0), &mut icon)?;
        }
        let x = cursor.ptScreenPos.x - info.rcMonitor.left - icon.xHotspot as i32;
        let y = cursor.ptScreenPos.y - info.rcMonitor.top - icon.yHotspot as i32;
        // GetIconInfo allocates these bitmaps; DrawIconEx uses the cursor handle itself.
        unsafe {
            if !icon.hbmMask.is_invalid() {
                let _ = DeleteObject(icon.hbmMask.into());
            }
            if !icon.hbmColor.is_invalid() {
                let _ = DeleteObject(icon.hbmColor.into());
            }
        }
        self.draw_icon(source, HICON(cursor.hCursor.0), x, y)
    }

    fn draw_icon(
        &mut self,
        source: &ID3D11Texture2D,
        icon: HICON,
        x: i32,
        y: i32,
    ) -> Result<ID3D11Texture2D> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
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
        // ReleaseDC must run even if drawing fails, before the consumer submits D3D commands.
        unsafe {
            self.gpu.context.CopyResource(texture, source);
            let dc = surface.GetDC(false)?;
            let drawn = DrawIconEx(dc, x, y, icon, 0, 0, 0, None, DI_NORMAL);
            surface.ReleaseDC(None)?;
            drawn?;
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
        let icon = HICON(unsafe { LoadCursorW(None, IDC_ARROW).unwrap() }.0);
        let mut overlay = CursorOverlay::new(&gpu);
        let drawn = overlay.draw_icon(&source, icon, 8, 8).unwrap();
        assert_ne!(drawn, source);
        let surface: IDXGISurface1 = drawn.cast().unwrap();
        // SAFETY: Each DC is released before any further D3D work.
        unsafe {
            let dc = surface.GetDC(false).unwrap();
            let visible = (8..40).any(|y| (8..40).any(|x| GetPixel(dc, x, y).0 != 0));
            surface.ReleaseDC(None).unwrap();
            assert!(visible);
        }
        let cleared = overlay.draw_icon(&source, icon, -100, -100).unwrap();
        assert_eq!(drawn, cleared);
        unsafe {
            let dc = surface.GetDC(false).unwrap();
            let clean = (8..40).all(|y| (8..40).all(|x| GetPixel(dc, x, y).0 == 0));
            surface.ReleaseDC(None).unwrap();
            assert!(clean);
        }
    }
}
