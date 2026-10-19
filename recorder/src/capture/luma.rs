//! 黑畫面探測：GPU 縮出 thumb 並計算灰階總和，CPU 每秒只讀回 4 bytes。

use anyhow::{Context, Result};
use windows::core::{s, BOOL};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING;

use super::{FrameGate, Scaler};
use crate::gpu::Gpu;
/// 黑畫面判斷用的縮圖尺寸（與 luma.hlsl 寫死的 320×180 一致；與共享記憶體的 thumb 無關）。
const LUMA_W: u32 = 320;
const LUMA_H: u32 = 180;

pub(in crate::capture) struct LumaProbe {
    gpu: Gpu,
    shader: ID3D11ComputeShader,
    sum: ID3D11Buffer,
    output: ID3D11UnorderedAccessView,
    source: Option<(Scaler, ID3D11CommandList)>,
    slots: [Slot; 2],
    next: usize,
    gate: FrameGate,
}

impl LumaProbe {
    pub(in crate::capture) fn new(gpu: &Gpu) -> Result<Self> {
        let source = include_str!("luma.hlsl");
        let mut code = None;
        let mut errors = None;
        let mut shader = None;
        let mut sum = None;
        let mut output = None;
        // SAFETY: shader 原始碼在編譯期間有效，不使用 include；輸出 blobs 由 windows crate 管理。
        unsafe {
            D3DCompile(
                source.as_ptr().cast(),
                source.len(),
                s!("aditorrec-luma"),
                None,
                None,
                s!("main"),
                s!("cs_5_0"),
                0,
                0,
                &mut code,
                Some(&mut errors),
            )
            .context("編譯黑畫面探測 shader 失敗")?;
            let code = code.context("缺少黑畫面探測 shader 位元碼")?;
            let bytes = std::slice::from_raw_parts(
                code.GetBufferPointer().cast::<u8>(),
                code.GetBufferSize(),
            );
            gpu.device
                .CreateComputeShader(bytes, None, Some(&mut shader))?;
            gpu.device.CreateBuffer(
                &D3D11_BUFFER_DESC {
                    ByteWidth: 4,
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_UNORDERED_ACCESS.0 as u32,
                    MiscFlags: D3D11_RESOURCE_MISC_BUFFER_STRUCTURED.0 as u32,
                    StructureByteStride: 4,
                    ..Default::default()
                },
                None,
                Some(&mut sum),
            )?;
            gpu.device.CreateUnorderedAccessView(
                sum.as_ref().context("缺少亮度總和 buffer")?,
                None,
                Some(&mut output),
            )?;
        }
        Ok(Self {
            gpu: gpu.clone(),
            shader: shader.context("缺少亮度計算 shader")?,
            sum: sum.context("缺少亮度總和 buffer")?,
            output: output.context("缺少亮度輸出 view")?,
            source: None,
            slots: [Slot::new(gpu)?, Slot::new(gpu)?],
            next: 0,
            gate: FrameGate::new(1),
        })
    }

    pub(in crate::capture) fn reset(&mut self) {
        self.gate = FrameGate::new(1);
        for slot in &mut self.slots {
            slot.pts = None;
        }
    }

    pub(in crate::capture) fn on_frame(
        &mut self,
        texture: &ID3D11Texture2D,
        size: (u32, u32),
        pts: i64,
    ) -> Result<Option<(i64, bool)>> {
        let previous = 1 - self.next;
        let result = self.slots[previous].read(&self.gpu)?;
        if self.gate.accept(pts) {
            if self.source.as_ref().map(|(scaler, _)| scaler.input_size) != Some(size) {
                let scaler = Scaler::new(&self.gpu, size, (LUMA_W, LUMA_H))?;
                let commands = self.commands(&scaler.output)?;
                self.source = Some((scaler, commands));
            }
            let (scaler, commands) = self.source.as_ref().context("缺少黑畫面探測縮放器")?;
            scaler.scale(&self.gpu, texture)?;
            let slot = &mut self.slots[self.next];
            // SAFETY: command list 只存取本 probe 的資源；ExecuteCommandList 原子提交並保留共用 context 狀態。
            unsafe {
                self.gpu.context.ExecuteCommandList(commands, true);
                self.gpu.context.CopyResource(&slot.staging, &self.sum);
                self.gpu.context.End(&slot.ready);
                self.gpu.context.Flush();
            }
            slot.pts = Some(pts);
            self.next = previous;
        }
        Ok(result)
    }

    fn commands(&self, thumb: &ID3D11Texture2D) -> Result<ID3D11CommandList> {
        let mut context = None;
        let mut input = None;
        let mut commands = None;
        // SAFETY: 專用 deferred context 在此方法內獨占使用；所有 shader 參照的資源活到 command list 釋放。
        unsafe {
            self.gpu
                .device
                .CreateDeferredContext(0, Some(&mut context))?;
            let context = context.context("缺少亮度計算 deferred context")?;
            self.gpu
                .device
                .CreateShaderResourceView(thumb, None, Some(&mut input))?;
            context.CSSetShader(&self.shader, None);
            context.CSSetShaderResources(0, Some(&[input]));
            context.CSSetUnorderedAccessViews(
                0,
                1,
                Some([Some(self.output.clone())].as_ptr()),
                None,
            );
            context.Dispatch(1, 1, 1);
            context.FinishCommandList(false, Some(&mut commands))
        }
        .context("建立亮度計算 command list 失敗")?;
        commands.context("缺少亮度計算 command list")
    }
}

struct Slot {
    staging: ID3D11Buffer,
    ready: ID3D11Query,
    pts: Option<i64>,
}

impl Slot {
    fn new(gpu: &Gpu) -> Result<Self> {
        let mut staging = None;
        let mut ready = None;
        // SAFETY: staging 是僅供 CPU 讀取的 4-byte buffer，query 不會啟動 GPU 等待。
        unsafe {
            gpu.device.CreateBuffer(
                &D3D11_BUFFER_DESC {
                    ByteWidth: 4,
                    Usage: D3D11_USAGE_STAGING,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut staging),
            )?;
            gpu.device.CreateQuery(
                &D3D11_QUERY_DESC {
                    Query: D3D11_QUERY_EVENT,
                    MiscFlags: 0,
                },
                Some(&mut ready),
            )?;
        }
        Ok(Self {
            staging: staging.context("缺少亮度 staging")?,
            ready: ready.context("缺少亮度完成事件")?,
            pts: None,
        })
    }

    fn read(&mut self, gpu: &Gpu) -> Result<Option<(i64, bool)>> {
        let Some(pts) = self.pts else { return Ok(None) };
        let mut complete = BOOL::default();
        let mut data = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: query 讀取 BOOL；確認就緒後仍以 DO_NOT_WAIT 映射，僅讀取一個有效 u32 並配對 Unmap。
        unsafe {
            gpu.context.GetData(
                &self.ready,
                Some((&mut complete as *mut BOOL).cast()),
                std::mem::size_of_val(&complete) as u32,
                D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32,
            )?;
            if !complete.as_bool() {
                return Ok(None);
            }
            if let Err(error) = gpu.context.Map(
                &self.staging,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut data),
            ) {
                if error.code() == DXGI_ERROR_WAS_STILL_DRAWING {
                    return Ok(None);
                }
                return Err(error).context("讀回 thumb 亮度失敗");
            }
            let sum = data.pData.cast::<u32>().read_unaligned();
            gpu.context.Unmap(&self.staging, 0);
            self.pts = None;
            Ok(Some((pts, sum < LUMA_W * LUMA_H * 2)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn gpu_luma_uses_full_thumb_and_strict_black_threshold() {
        let gpu = Gpu::create().unwrap();
        let texture = super::super::texture(&gpu, (960, 540), false).unwrap();
        let mut view = None;
        // SAFETY: 單層 BGRA render target 的描述由 texture helper 保證，輸出 view 由 windows crate 管理。
        unsafe {
            gpu.device
                .CreateRenderTargetView(&texture, None, Some(&mut view))
                .unwrap()
        };
        let view = view.unwrap();
        let mut probe = LumaProbe::new(&gpu).unwrap();
        for (color, black) in [
            ([0.0, 0.0, 0.0, 1.0], true),
            ([1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 1.0], true),
            ([2.0 / 255.0, 2.0 / 255.0, 2.0 / 255.0, 1.0], false),
            ([1.0, 0.0, 0.0, 1.0], false),
            ([0.0, 1.0, 0.0, 1.0], false),
            ([0.0, 0.0, 1.0, 1.0], false),
        ] {
            probe.reset();
            // SAFETY: 此測試獨占 texture，view 在整段 GPU 清除與取樣期間有效。
            unsafe { gpu.context.ClearRenderTargetView(&view, &color) };
            assert!(probe.on_frame(&texture, (960, 540), 0).unwrap().is_none());
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if let Some((pts, detected)) = probe.on_frame(&texture, (960, 540), 1).unwrap() {
                    assert_eq!(pts, 0);
                    assert_eq!(detected, black, "顏色 {color:?} 的黑畫面判定不符");
                    break;
                }
                assert!(Instant::now() < deadline, "GPU 亮度計算逾時");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}
