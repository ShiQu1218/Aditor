//! Black-frame detection: downscale to a thumbnail and sum grayscale values on the GPU; the CPU reads back only 4 bytes per second.

use anyhow::{Context, Result};
use windows::core::{s, BOOL};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING;

use super::{FrameGate, Scaler};
use crate::gpu::Gpu;
/// Thumbnail dimensions used for black-frame detection (must match the 320×180 size hardcoded in luma.hlsl; unrelated to the shared-memory thumb).
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
        // SAFETY: Shader source remains valid during compilation and does not use includes; the windows crate manages output blobs.
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
            .context("Failed to compile black-frame detection shader")?;
            let code = code.context("Missing black-frame detection shader bytecode")?;
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
                sum.as_ref().context("Missing luminance sum buffer")?,
                None,
                Some(&mut output),
            )?;
        }
        Ok(Self {
            gpu: gpu.clone(),
            shader: shader.context("Missing luminance computation shader")?,
            sum: sum.context("Missing luminance sum buffer")?,
            output: output.context("Missing luminance output view")?,
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
            let (scaler, commands) = self
                .source
                .as_mut()
                .context("Missing black-frame detection scaler")?;
            scaler.scale(&self.gpu, texture)?;
            let slot = &mut self.slots[self.next];
            // SAFETY: The command list accesses only this probe's resources; ExecuteCommandList submits atomically and preserves shared context state.
            unsafe {
                self.gpu.context.ExecuteCommandList(&*commands, true);
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
        // SAFETY: The dedicated deferred context is used exclusively in this method; resources referenced by the shader remain alive until the command list is released.
        unsafe {
            self.gpu
                .device
                .CreateDeferredContext(0, Some(&mut context))?;
            let context = context.context("Missing luminance computation deferred context")?;
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
        .context("Failed to create luminance computation command list")?;
        commands.context("Missing luminance computation command list")
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
        // SAFETY: staging is a 4-byte buffer used only for CPU reads; the query does not wait for the GPU.
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
            staging: staging.context("Missing luminance staging buffer")?,
            ready: ready.context("Missing luminance completion event")?,
            pts: None,
        })
    }

    fn read(&mut self, gpu: &Gpu) -> Result<Option<(i64, bool)>> {
        let Some(pts) = self.pts else { return Ok(None) };
        let mut complete = BOOL::default();
        let mut data = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: The query reads a BOOL; even after it reports completion, map with DO_NOT_WAIT, read one valid u32, and pair it with Unmap.
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
                return Err(error).context("Failed to read back thumbnail luminance");
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
        // SAFETY: The texture helper guarantees a single-layer BGRA render target; the windows crate manages the output view.
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
            // SAFETY: The test exclusively owns texture; view remains valid throughout GPU clearing and sampling.
            unsafe { gpu.context.ClearRenderTargetView(&view, &color) };
            assert!(probe.on_frame(&texture, (960, 540), 0).unwrap().is_none());
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if let Some((pts, detected)) = probe.on_frame(&texture, (960, 540), 1).unwrap() {
                    assert_eq!(pts, 0);
                    assert_eq!(
                        detected, black,
                        "Incorrect black-frame classification for color {color:?}"
                    );
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "GPU luminance computation timed out"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}
