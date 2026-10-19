//! 將 hook 的共享材質複製或轉換為我們自有的 `DXGI_FORMAT_B8G8R8A8_UNORM` 材質。
//!
//! - `B8G8R8A8_*`：同 typeless 家族，直接以 `CopyResource` 原樣搬移位元組。
//! - `B8G8R8X8_*`、`R8G8B8A8_*`、`R10G10B10A2_*`：以滿版三角形 pixel shader 畫進 BGRA RTV。
//!   由於共用裝置的 immediate context 被擷取、小圖與編碼執行緒共用，而 `ID3D11Multithread`
//!   只保護單一 API 呼叫，因此繪製狀態與 `Draw` 先在 deferred context 錄成 `ID3D11CommandList`，
//!   每格 `run` 時以 `ExecuteCommandList(list, true)` 原子提交並還原 immediate context 狀態。

use anyhow::{bail, Context, Result};
use windows::core::{s, PCSTR};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{
    ID3DBlob, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST, D3D_SRV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11CommandList, ID3D11PixelShader, ID3D11RenderTargetView, ID3D11ShaderResourceView,
    ID3D11Texture2D, ID3D11VertexShader, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_SHADER_RESOURCE_VIEW_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC_0, D3D11_TEX2D_SRV,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_B8G8R8X8_TYPELESS,
    DXGI_FORMAT_B8G8R8X8_UNORM, DXGI_FORMAT_B8G8R8X8_UNORM_SRGB, DXGI_FORMAT_R10G10B10A2_TYPELESS,
    DXGI_FORMAT_R10G10B10A2_UNORM, DXGI_FORMAT_R8G8B8A8_TYPELESS, DXGI_FORMAT_R8G8B8A8_UNORM,
    DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, DXGI_SAMPLE_DESC,
};

use super::protocol::{conversion_for, TextureConversion};
use crate::gpu::Gpu;

const SHADER_SOURCE: &str = include_str!("convert.hlsl");

/// 依來源 `DXGI_FORMAT` 數值決定 pixel shader 讀取用的 SRV 格式。
/// 一律使用 `*_UNORM`（不用 `*_SRGB`），讓位元組原樣進出、不做 gamma 轉換。
pub fn srv_format_for(dxgi_format: u32) -> Option<DXGI_FORMAT> {
    match DXGI_FORMAT(dxgi_format as i32) {
        DXGI_FORMAT_R8G8B8A8_TYPELESS
        | DXGI_FORMAT_R8G8B8A8_UNORM
        | DXGI_FORMAT_R8G8B8A8_UNORM_SRGB => Some(DXGI_FORMAT_R8G8B8A8_UNORM),
        DXGI_FORMAT_B8G8R8X8_TYPELESS
        | DXGI_FORMAT_B8G8R8X8_UNORM
        | DXGI_FORMAT_B8G8R8X8_UNORM_SRGB => Some(DXGI_FORMAT_B8G8R8X8_UNORM),
        DXGI_FORMAT_R10G10B10A2_TYPELESS | DXGI_FORMAT_R10G10B10A2_UNORM => {
            Some(DXGI_FORMAT_R10G10B10A2_UNORM)
        }
        _ => None,
    }
}

enum Plan {
    Copy { source: ID3D11Texture2D },
    Shader { commands: ID3D11CommandList },
}

/// 把 hook 的共享材質轉成我們自有的 `B8G8R8A8_UNORM` 材質（每格呼叫一次 `run`）。
pub struct Converter {
    output: ID3D11Texture2D,
    size: (u32, u32),
    plan: Plan,
}

// SAFETY: 所持有的 D3D11 材質與 command list 均由開啟 multithread 保護的共用裝置建立，
// 且 Converter 只由擷取執行緒獨占持有與呼叫。
unsafe impl Send for Converter {}

impl Converter {
    /// `source` 為 open_shared 取得的材質；依 `conversion_for(format)` 建立對應的轉換。
    pub fn new(gpu: &Gpu, source: &ID3D11Texture2D, format: u32) -> Result<Self> {
        let Some(conversion) = conversion_for(format) else {
            bail!("hook_unavailable: 不支援的共享材質格式（DXGI_FORMAT={format}）");
        };

        let mut src_desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: source 為呼叫端提供的有效 D3D11 2D 材質。
        unsafe { source.GetDesc(&mut src_desc) };
        if src_desc.Width == 0 || src_desc.Height == 0 {
            bail!(
                "hook_unavailable: 共享材質尺寸無效（{}x{}）",
                src_desc.Width,
                src_desc.Height
            );
        }
        let size = (src_desc.Width, src_desc.Height);

        let out_desc = D3D11_TEXTURE2D_DESC {
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
            BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
            ..Default::default()
        };
        let mut output = None;
        // SAFETY: 建立我們自有的單層 BGRA 輸出材質，供 RTV 繪製、VideoProcessor 縮放與編碼器複製使用。
        unsafe {
            gpu.device
                .CreateTexture2D(&out_desc, None, Some(&mut output))
                .context("建立轉換輸出材質失敗")?;
        }
        let output = output.context("缺少轉換輸出材質")?;

        let plan = match conversion {
            TextureConversion::Copy => Plan::Copy {
                source: source.clone(),
            },
            TextureConversion::Bgrx8
            | TextureConversion::SwizzleRgba8
            | TextureConversion::Rgb10a2 => {
                let srv_format = srv_format_for(format).with_context(|| {
                    format!("hook_unavailable: 不支援的共享材質格式（DXGI_FORMAT={format}）")
                })?;
                let ps_entry = match conversion {
                    TextureConversion::Bgrx8 => s!("ps_bgrx"),
                    _ => s!("ps_main"),
                };
                let commands = record_draw(gpu, source, &output, size, srv_format, ps_entry)?;
                Plan::Shader { commands }
            }
        };

        Ok(Self { output, size, plan })
    }

    /// 執行轉換；回傳的材質在下一次 run 前內容有效。
    pub fn run(&self, gpu: &Gpu) -> &ID3D11Texture2D {
        match &self.plan {
            Plan::Copy { source } => {
                // SAFETY: output 與 source 為同裝置、同尺寸且屬於同一 typeless 家族的材質；
                // 單一 CopyResource 由裝置的 multithread 保護同步。
                unsafe {
                    gpu.context.CopyResource(&self.output, source);
                }
            }
            Plan::Shader { commands } => {
                // SAFETY: command list 僅操作本 Converter 的資源，ExecuteCommandList(..., true)
                // 以原子方式提交並還原共用 immediate context 的狀態。
                unsafe {
                    gpu.context.ExecuteCommandList(commands, true);
                }
            }
        }
        &self.output
    }

    pub fn size(&self) -> (u32, u32) {
        self.size
    }
}

fn compile_shader(entry: PCSTR, target: PCSTR) -> Result<ID3DBlob> {
    let mut code = None;
    let mut errors = None;
    // SAFETY: SHADER_SOURCE 為靜態字串，編譯期間有效且不使用 include；回傳的 blob 由 windows crate 管理。
    unsafe {
        D3DCompile(
            SHADER_SOURCE.as_ptr().cast(),
            SHADER_SOURCE.len(),
            s!("aditorrec-convert"),
            None,
            None,
            entry,
            target,
            0,
            0,
            &mut code,
            Some(&mut errors),
        )
        .context("編譯格式轉換 shader 失敗")?;
    }
    code.context("缺少格式轉換 shader 位元碼")
}

fn record_draw(
    gpu: &Gpu,
    source: &ID3D11Texture2D,
    output: &ID3D11Texture2D,
    size: (u32, u32),
    srv_format: DXGI_FORMAT,
    ps_entry: PCSTR,
) -> Result<ID3D11CommandList> {
    let vs_blob = compile_shader(s!("vs_main"), s!("vs_5_0"))?;
    let ps_blob = compile_shader(ps_entry, s!("ps_5_0"))?;

    let mut vs: Option<ID3D11VertexShader> = None;
    let mut ps: Option<ID3D11PixelShader> = None;
    let mut srv: Option<ID3D11ShaderResourceView> = None;
    let mut rtv: Option<ID3D11RenderTargetView> = None;
    let mut deferred = None;
    let mut commands = None;

    let srv_desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
        Format: srv_format,
        ViewDimension: D3D_SRV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_SRV {
                MostDetailedMip: 0,
                MipLevels: 1,
            },
        },
    };

    // SAFETY: 建立 shader、SRV、RTV，並在專屬的 deferred context 上錄製滿版三角形繪製指令；
    // 所有受參照資源由 command list 與 Converter 維持生命週期。
    unsafe {
        let vs_bytes = std::slice::from_raw_parts(
            vs_blob.GetBufferPointer().cast::<u8>(),
            vs_blob.GetBufferSize(),
        );
        gpu.device
            .CreateVertexShader(vs_bytes, None, Some(&mut vs))
            .context("建立格式轉換 vertex shader 失敗")?;
        let vs = vs.context("缺少格式轉換 vertex shader")?;

        let ps_bytes = std::slice::from_raw_parts(
            ps_blob.GetBufferPointer().cast::<u8>(),
            ps_blob.GetBufferSize(),
        );
        gpu.device
            .CreatePixelShader(ps_bytes, None, Some(&mut ps))
            .context("建立格式轉換 pixel shader 失敗")?;
        let ps = ps.context("缺少格式轉換 pixel shader")?;

        gpu.device
            .CreateShaderResourceView(source, Some(&srv_desc), Some(&mut srv))
            .context("建立來源材質 SRV 失敗")?;
        let srv = srv.context("缺少來源材質 SRV")?;

        gpu.device
            .CreateRenderTargetView(output, None, Some(&mut rtv))
            .context("建立輸出材質 RTV 失敗")?;
        let rtv = rtv.context("缺少輸出材質 RTV")?;

        gpu.device
            .CreateDeferredContext(0, Some(&mut deferred))
            .context("建立格式轉換 deferred context 失敗")?;
        let dc = deferred.context("缺少格式轉換 deferred context")?;

        dc.ClearState();
        dc.IASetInputLayout(None);
        dc.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        dc.VSSetShader(&vs, None);
        dc.PSSetShader(&ps, None);
        dc.PSSetShaderResources(0, Some(&[Some(srv)]));
        dc.OMSetRenderTargets(Some(&[Some(rtv)]), None);
        dc.RSSetViewports(Some(&[D3D11_VIEWPORT {
            TopLeftX: 0.0,
            TopLeftY: 0.0,
            Width: size.0 as f32,
            Height: size.1 as f32,
            MinDepth: 0.0,
            MaxDepth: 1.0,
        }]));
        dc.Draw(3, 0);
        dc.FinishCommandList(false, Some(&mut commands))
            .context("完成格式轉換 command list 失敗")?;
    }

    commands.context("缺少格式轉換 command list")
}

#[cfg(test)]
mod tests {
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
        D3D11_RESOURCE_MISC_SHARED, D3D11_SUBRESOURCE_DATA, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_B8G8R8A8_TYPELESS, DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_FORMAT_NV12,
        DXGI_FORMAT_R10G10B10A2_UINT, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_UNKNOWN,
    };
    use windows::Win32::Graphics::Dxgi::IDXGIResource;

    use super::*;
    use crate::capture::hook::adapter::open_shared;

    const TEST_W: u32 = 4;
    const TEST_H: u32 = 2;

    fn create_source_texture(
        gpu: &Gpu,
        format: DXGI_FORMAT,
        pixels: &[[u8; 4]; (TEST_W * TEST_H) as usize],
        shared: bool,
    ) -> ID3D11Texture2D {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: TEST_W,
            Height: TEST_H,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            MiscFlags: if shared {
                D3D11_RESOURCE_MISC_SHARED.0 as u32
            } else {
                0
            },
            ..Default::default()
        };
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: TEST_W * 4,
            SysMemSlicePitch: 0,
        };
        let mut tex = None;
        // SAFETY: pixels 緩衝區大小為 4 * 2 * 4 bytes，與 SysMemPitch 及材質尺寸一致。
        unsafe {
            gpu.device
                .CreateTexture2D(&desc, Some(&init), Some(&mut tex))
                .unwrap();
        }
        tex.unwrap()
    }

    fn readback_bgra(
        gpu: &Gpu,
        texture: &ID3D11Texture2D,
    ) -> [[u8; 4]; (TEST_W * TEST_H) as usize] {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: TEST_W,
            Height: TEST_H,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            ..Default::default()
        };
        let mut staging = None;
        let mut out = [[0u8; 4]; (TEST_W * TEST_H) as usize];
        // SAFETY: 建立同尺寸 BGRA staging 材質，CopyResource 後 Map 讀回每列像素並 Unmap。
        unsafe {
            gpu.device
                .CreateTexture2D(&desc, None, Some(&mut staging))
                .unwrap();
            let staging = staging.unwrap();
            gpu.context.CopyResource(&staging, texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            gpu.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .unwrap();
            let base = mapped.pData.cast::<u8>();
            let pitch = mapped.RowPitch as usize;
            for y in 0..TEST_H as usize {
                for x in 0..TEST_W as usize {
                    let ptr = base.add(y * pitch + x * 4);
                    out[y * TEST_W as usize + x] = [*ptr, *ptr.add(1), *ptr.add(2), *ptr.add(3)];
                }
            }
            gpu.context.Unmap(&staging, 0);
        }
        out
    }

    #[test]
    fn srv_format_maps_all_families_to_unorm_and_rejects_others() {
        for format in [
            DXGI_FORMAT_R8G8B8A8_TYPELESS,
            DXGI_FORMAT_R8G8B8A8_UNORM,
            DXGI_FORMAT_R8G8B8A8_UNORM_SRGB,
        ] {
            assert_eq!(
                srv_format_for(format.0 as u32),
                Some(DXGI_FORMAT_R8G8B8A8_UNORM),
                "{format:?}"
            );
        }
        for format in [
            DXGI_FORMAT_B8G8R8X8_TYPELESS,
            DXGI_FORMAT_B8G8R8X8_UNORM,
            DXGI_FORMAT_B8G8R8X8_UNORM_SRGB,
        ] {
            assert_eq!(
                srv_format_for(format.0 as u32),
                Some(DXGI_FORMAT_B8G8R8X8_UNORM),
                "{format:?}"
            );
        }
        for format in [
            DXGI_FORMAT_R10G10B10A2_TYPELESS,
            DXGI_FORMAT_R10G10B10A2_UNORM,
        ] {
            assert_eq!(
                srv_format_for(format.0 as u32),
                Some(DXGI_FORMAT_R10G10B10A2_UNORM),
                "{format:?}"
            );
        }
        for format in [
            DXGI_FORMAT_B8G8R8A8_TYPELESS,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            DXGI_FORMAT_B8G8R8A8_UNORM_SRGB,
            DXGI_FORMAT_UNKNOWN,
            DXGI_FORMAT_NV12,
            DXGI_FORMAT_R16G16B16A16_FLOAT,
            DXGI_FORMAT_R10G10B10A2_UINT,
        ] {
            assert_eq!(srv_format_for(format.0 as u32), None, "{format:?}");
        }
    }

    #[test]
    fn converts_bgra8_rgba8_typeless_bgrx8_and_rgb10a2_to_bgra8() {
        let gpu = Gpu::create().unwrap();

        // 1. B8G8R8A8_UNORM（CopyResource）：輸入即為 [B, G, R, A]。
        let bgra_src_pixels: [[u8; 4]; 8] = [
            [0, 0, 255, 255],     // (0,0) 純紅 R=255, G=0, B=0, A=255
            [30, 20, 10, 128],    // (1,0) R=10, G=20, B=30, A=128
            [255, 0, 0, 255],     // (2,0) 純藍
            [0, 255, 0, 64],      // (3,0) 純綠
            [1, 2, 3, 4],         // (0,1)
            [50, 60, 70, 80],     // (1,1)
            [90, 100, 110, 120],  // (2,1)
            [200, 210, 220, 230], // (3,1)
        ];
        let bgra_tex =
            create_source_texture(&gpu, DXGI_FORMAT_B8G8R8A8_UNORM, &bgra_src_pixels, false);
        let conv = Converter::new(&gpu, &bgra_tex, DXGI_FORMAT_B8G8R8A8_UNORM.0 as u32).unwrap();
        assert_eq!(conv.size(), (TEST_W, TEST_H));
        let out = readback_bgra(&gpu, conv.run(&gpu));
        assert_eq!(out, bgra_src_pixels);

        // 2. R8G8B8A8_UNORM 與 R8G8B8A8_TYPELESS：輸入位元組為 [R, G, B, A]，輸出應轉為 [B, G, R, A]。
        let rgba_src_pixels: [[u8; 4]; 8] = [
            [255, 0, 0, 255],     // (0,0) 純紅 R=255, G=0, B=0, A=255
            [10, 20, 30, 200],    // (1,0) R=10, G=20, B=30, A=200
            [0, 255, 0, 128],     // (2,0) 純綠
            [0, 0, 255, 64],      // (3,0) 純藍
            [40, 50, 60, 70],     // (0,1)
            [80, 90, 100, 110],   // (1,1)
            [12, 34, 56, 78],     // (2,1)
            [250, 240, 230, 220], // (3,1)
        ];
        let expected_from_rgba: [[u8; 4]; 8] = rgba_src_pixels.map(|[r, g, b, a]| [b, g, r, a]);

        for tex_format in [DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R8G8B8A8_TYPELESS] {
            let rgba_tex = create_source_texture(&gpu, tex_format, &rgba_src_pixels, false);
            let conv = Converter::new(&gpu, &rgba_tex, tex_format.0 as u32).unwrap();
            let out = readback_bgra(&gpu, conv.run(&gpu));
            assert_eq!(out, expected_from_rgba, "格式 {tex_format:?} 轉換結果不符");
        }

        // 3. B8G8R8X8_UNORM：輸入位元組為 [B, G, R, X]，輸出應保留 B,G,R 並將 A 設為 255。
        let bgrx_src_pixels: [[u8; 4]; 8] = [
            [0, 0, 255, 0],      // (0,0) 純紅，X=0
            [30, 20, 10, 42],    // (1,0) R=10, G=20, B=30, X=42
            [255, 0, 0, 99],     // (2,0) 純藍，X=99
            [0, 255, 0, 123],    // (3,0) 純綠，X=123
            [5, 15, 25, 0],      // (0,1)
            [35, 45, 55, 7],     // (1,1)
            [65, 75, 85, 19],    // (2,1)
            [95, 105, 115, 250], // (3,1)
        ];
        let expected_from_bgrx: [[u8; 4]; 8] = bgrx_src_pixels.map(|[b, g, r, _]| [b, g, r, 255]);
        let bgrx_tex =
            create_source_texture(&gpu, DXGI_FORMAT_B8G8R8X8_UNORM, &bgrx_src_pixels, false);
        let conv = Converter::new(&gpu, &bgrx_tex, DXGI_FORMAT_B8G8R8X8_UNORM.0 as u32).unwrap();
        let out = readback_bgra(&gpu, conv.run(&gpu));
        assert_eq!(out, expected_from_bgrx);

        // 4. R10G10B10A2_UNORM：打包格式為 R(0..9) | G(10..19) | B(20..29) | A(30..31)。
        let pack_r10g10b10a2 = |r: u32, g: u32, b: u32, a: u32| -> [u8; 4] {
            let word = (r & 0x3ff) | ((g & 0x3ff) << 10) | ((b & 0x3ff) << 20) | ((a & 0x3) << 30);
            word.to_le_bytes()
        };
        let r10_src_pixels: [[u8; 4]; 8] = [
            pack_r10g10b10a2(1023, 0, 0, 3), // 純紅：R=1023->255, G=0->0, B=0->0, A=3->255
            pack_r10g10b10a2(0, 1023, 0, 3), // 純綠：R=0->0, G=1023->255, B=0->0, A=3->255
            pack_r10g10b10a2(0, 0, 1023, 3), // 純藍：R=0->0, G=0->0, B=1023->255, A=3->255
            pack_r10g10b10a2(0, 0, 0, 0),    // 全 0
            pack_r10g10b10a2(1023, 1023, 1023, 3), // 全滿白
            pack_r10g10b10a2(40, 80, 120, 3), // 約 (10, 20, 30)
            pack_r10g10b10a2(0, 1023, 1023, 0), // 青色，A=0
            pack_r10g10b10a2(1023, 0, 1023, 3), // 洋紅，A=3
        ];
        let r10_tex =
            create_source_texture(&gpu, DXGI_FORMAT_R10G10B10A2_UNORM, &r10_src_pixels, false);
        let conv = Converter::new(&gpu, &r10_tex, DXGI_FORMAT_R10G10B10A2_UNORM.0 as u32).unwrap();
        let out = readback_bgra(&gpu, conv.run(&gpu));
        assert_eq!(out[0], [0, 0, 255, 255]); // 純紅 -> B=0, G=0, R=255, A=255
        assert_eq!(out[1], [0, 255, 0, 255]); // 純綠 -> B=0, G=255, R=0, A=255
        assert_eq!(out[2], [255, 0, 0, 255]); // 純藍 -> B=255, G=0, R=0, A=255
        assert_eq!(out[3], [0, 0, 0, 0]);
        assert_eq!(out[4], [255, 255, 255, 255]);
        assert_eq!(out[5], [30, 20, 10, 255]);
        assert_eq!(out[6], [255, 255, 0, 0]);
        assert_eq!(out[7], [255, 0, 255, 255]);

        // 5. 不支援的格式回傳 hook_unavailable。
        let err = match Converter::new(&gpu, &bgra_tex, DXGI_FORMAT_NV12.0 as u32) {
            Ok(_) => panic!("不支援的格式不應建立成功"),
            Err(err) => err.to_string(),
        };
        assert!(err.starts_with("hook_unavailable:"), "{err}");
    }

    #[test]
    fn shared_texture_open_and_convert_end_to_end() {
        let creator = Gpu::create().unwrap();
        let rgba_pixels: [[u8; 4]; 8] = [
            [255, 0, 0, 255],  // 純紅 R=255, G=0, B=0, A=255
            [10, 20, 30, 255], // R=10, G=20, B=30, A=255
            [0, 255, 0, 255],
            [0, 0, 255, 255],
            [100, 110, 120, 255],
            [130, 140, 150, 255],
            [160, 170, 180, 255],
            [190, 200, 210, 255],
        ];
        let shared_src =
            create_source_texture(&creator, DXGI_FORMAT_R8G8B8A8_UNORM, &rgba_pixels, true);
        // SAFETY: 確保建立材質的裝置將初始資料提交至共享資源。
        unsafe { creator.context.Flush() };

        let resource: IDXGIResource = shared_src.cast().unwrap();
        // SAFETY: 取得舊式共享資源 handle。
        let raw_handle = unsafe { resource.GetSharedHandle() }.unwrap();
        let handle = raw_handle.0 as usize as u32;

        let (gpu, opened) = open_shared(handle).unwrap();
        let converter = Converter::new(&gpu, &opened, DXGI_FORMAT_R8G8B8A8_UNORM.0 as u32).unwrap();
        assert_eq!(converter.size(), (TEST_W, TEST_H));
        let output = converter.run(&gpu);
        let actual = readback_bgra(&gpu, output);
        let expected: [[u8; 4]; 8] = rgba_pixels.map(|[r, g, b, a]| [b, g, r, a]);
        assert_eq!(actual, expected);
    }
}
