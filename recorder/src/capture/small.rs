//! Small-image capture (task B2): crop banner/spec ROIs and scale to a 320×180 grayscale thumbnail on the GPU,
//! reading back to the CPU at 4 fps (spec §3.3).
//!
//! Readback must be asynchronous: `CopySubresourceRegion` into staging for this frame, then `Map` the previous
//! staging buffer at the **next** sample (double buffering) to avoid stalling the GPU pipeline. Output dimensions match the ROI at reference resolution;
//! scale on the GPU when the actual frame is not 1920×1080 (matching offline scaling to 1920×1080 before cropping).

use std::mem::ManuallyDrop;

use anyhow::{bail, Context, Result};
use windows::core::Interface;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING;

use super::FrameGate;
use crate::gpu::Gpu;
use crate::types::{FramesSpec, Rect, SMALL_FPS, THUMB_EVERY, THUMB_H, THUMB_W};

#[path = "luma.rs"]
mod luma;
pub(super) use luma::LumaProbe;

/// A set of read-back thumbnails. banner/spec use tightly packed BGR24 rows (no padding); thumb uses GRAY8.
#[derive(Debug, Clone, PartialEq)]
pub struct SmallFrames {
    pub pts: i64,
    pub banner: Vec<u8>,
    pub spec: Vec<u8>,
    pub killfeed: Option<Vec<u8>>,
    pub thumb: Option<Vec<u8>>,
}

pub struct SmallFrameExtractor {
    gpu: Gpu,
    frames: FramesSpec,
    slots: [Readback; 2],
    next_slot: usize,
    samples: u64,
    gate: FrameGate,
    scaler: Option<Scaler>,
    thumb_scaler: Scaler,
    dropped: u64,
    last_error: Option<String>,
}

// SAFETY: All D3D11 objects come from Gpu's multithread-protected device; mutable extractor state is accessed only through &mut.
unsafe impl Send for SmallFrameExtractor {}

impl SmallFrameExtractor {
    pub fn new(gpu: &Gpu, frames: FramesSpec) -> Result<Self> {
        validate_spec(frames)?;
        Ok(Self {
            gpu: gpu.clone(),
            frames,
            slots: [Readback::new(gpu, frames)?, Readback::new(gpu, frames)?],
            next_slot: 0,
            samples: 0,
            gate: FrameGate::new(SMALL_FPS),
            scaler: None,
            thumb_scaler: Scaler::new(gpu, (1920, 1080), (THUMB_W, THUMB_H))?,
            dropped: 0,
            last_error: None,
        })
    }

    /// banner/spec output dimensions in reference coordinates.
    pub fn banner_size(&self) -> (u32, u32) {
        (self.frames.banner[2], self.frames.banner[3])
    }

    pub fn spec_size(&self) -> (u32, u32) {
        (self.frames.spec[2], self.frames.spec[3])
    }

    pub fn killfeed_size(&self) -> (u32, u32) {
        self.frames.killfeed.map(|r| (r[2], r[3])).unwrap_or((0, 0))
    }

    /// Called for every captured frame; throttled internally to `SMALL_FPS` using pts. Returns the previous sample's readback, if available.
    pub fn on_frame(
        &mut self,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
        pts: i64,
    ) -> Option<SmallFrames> {
        if width == 0 || height == 0 || !self.gate.accept(pts) {
            return None;
        }
        match self.sample(texture, width, height, pts) {
            Ok(result) => {
                self.last_error = None;
                result
            }
            Err(error) => {
                self.dropped += 1;
                let message = format!("{error:#}");
                if self.last_error.as_ref() != Some(&message) {
                    eprintln!("Thumbnail readback failed: {message}");
                    self.last_error = Some(message);
                }
                None
            }
        }
    }

    fn sample(
        &mut self,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
        pts: i64,
    ) -> Result<Option<SmallFrames>> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: texture is a valid COM object for the duration of this call; desc is a writable description structure.
        unsafe { texture.GetDesc(&mut desc) };
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
            || desc.Width < width
            || desc.Height < height
            || desc.SampleDesc.Count != 1
        {
            bail!("Thumbnail source must be a sufficiently large, single-sample BGRA texture");
        }

        let previous = 1 - self.next_slot;
        let normalized = if (width, height) == (1920, 1080) {
            texture
        } else {
            if self.scaler.as_ref().map(|s| s.input_size) != Some((width, height)) {
                self.scaler = Some(Scaler::new(&self.gpu, (width, height), (1920, 1080))?);
            }
            let scaler = self.scaler.as_ref().context("Missing reference-resolution scaler")?;
            scaler.scale(&self.gpu, texture)?;
            &scaler.output
        };
        let with_thumb = self.samples.is_multiple_of(THUMB_EVERY as u64);
        if with_thumb {
            self.thumb_scaler.scale(&self.gpu, normalized)?;
        }
        // Retrieve the previous result only after all scaling succeeds, so later errors do not discard completed readbacks.
        let result = self.slots[previous].read(&self.gpu)?;
        let slot = &mut self.slots[self.next_slot];
        if slot.pending.is_some() {
            self.dropped += 1;
        }
        copy_roi(&self.gpu, normalized, &slot.banner, self.frames.banner);
        copy_roi(&self.gpu, normalized, &slot.spec, self.frames.spec);
        if let (Some(texture), Some(rect)) = (&slot.killfeed, self.frames.killfeed) {
            copy_roi(&self.gpu, normalized, texture, rect);
        }
        if with_thumb {
            // SAFETY: Source and destination are unmapped textures with matching dimensions and formats.
            unsafe {
                self.gpu
                    .context
                    .CopyResource(&slot.thumb, &self.thumb_scaler.output);
            }
        }
        slot.pending = Some((pts, with_thumb));
        // SAFETY: The event query tracks only this slot's GPU copy and does not wait for completion in the callback.
        unsafe { self.gpu.context.End(&slot.ready) };
        // This device has no Present call; submit GPU work explicitly. Flush does not wait for the GPU to finish.
        // SAFETY: The shared context has multithread protection enabled; this only submits the current command buffer.
        unsafe { self.gpu.context.Flush() };
        self.samples += 1;
        self.next_slot = previous;
        Ok(result)
    }
}

fn validate_spec(frames: FramesSpec) -> Result<()> {
    if frames.base != [1920, 1080] {
        bail!("Thumbnail reference resolution must be 1920×1080");
    }
    for roi in [Some(frames.banner), Some(frames.spec), frames.killfeed].into_iter().flatten() {
        let [x, y, w, h] = roi;
        if w == 0 || h == 0 || x as u64 + w as u64 > 1920 || y as u64 + h as u64 > 1080 {
            bail!("Thumbnail ROI must fit within the reference frame and have nonzero width and height");
        }
    }
    Ok(())
}

struct Readback {
    banner: ID3D11Texture2D,
    spec: ID3D11Texture2D,
    killfeed: Option<ID3D11Texture2D>,
    thumb: ID3D11Texture2D,
    pending: Option<(i64, bool)>,
    ready: ID3D11Query,
}

impl Readback {
    fn new(gpu: &Gpu, frames: FramesSpec) -> Result<Self> {
        let mut ready = None;
        // SAFETY: Creates only a GPU completion event; the windows crate manages the query output.
        unsafe {
            gpu.device.CreateQuery(
                &D3D11_QUERY_DESC {
                    Query: D3D11_QUERY_EVENT,
                    MiscFlags: 0,
                },
                Some(&mut ready),
            )?
        };
        Ok(Self {
            banner: texture(gpu, (frames.banner[2], frames.banner[3]), true)?,
            spec: texture(gpu, (frames.spec[2], frames.spec[3]), true)?,
            killfeed: frames.killfeed.map(|r| texture(gpu, (r[2], r[3]), true)).transpose()?,
            thumb: texture(gpu, (THUMB_W, THUMB_H), true)?,
            pending: None,
            ready: ready.context("Missing thumbnail completion event")?,
        })
    }

    fn read(&mut self, gpu: &Gpu) -> Result<Option<SmallFrames>> {
        let Some((pts, with_thumb)) = self.pending else {
            return Ok(None);
        };
        let mut complete = windows::core::BOOL::default();
        // SAFETY: Read the event query as BOOL; DONOTFLUSH only queries status without waiting for the GPU.
        unsafe {
            gpu.context.GetData(
                &self.ready,
                Some((&mut complete as *mut windows::core::BOOL).cast()),
                std::mem::size_of_val(&complete) as u32,
                D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32,
            )?
        };
        if !complete.as_bool() {
            return Ok(None);
        }
        // Check that every staging texture is ready first; do not wait or return a partial set if any texture is still pending.
        let Some(banner) = Mapped::try_new(gpu, &self.banner)? else {
            return Ok(None);
        };
        let Some(spec) = Mapped::try_new(gpu, &self.spec)? else {
            return Ok(None);
        };
        let thumb = if with_thumb {
            let Some(mapped) = Mapped::try_new(gpu, &self.thumb)? else {
                return Ok(None);
            };
            Some(mapped)
        } else {
            None
        };
        let killfeed = if let Some(texture) = &self.killfeed {
            let Some(mapped) = Mapped::try_new(gpu, texture)? else { return Ok(None) };
            Some(mapped)
        } else {
            None
        };
        let result = SmallFrames {
            pts,
            banner: banner.pixels(false),
            spec: spec.pixels(false),
            killfeed: killfeed.as_ref().map(|mapped| mapped.pixels(false)),
            thumb: thumb.as_ref().map(|mapped| mapped.pixels(true)),
        };
        self.pending = None;
        Ok(Some(result))
    }
}

struct Mapped<'a> {
    gpu: &'a Gpu,
    texture: &'a ID3D11Texture2D,
    data: D3D11_MAPPED_SUBRESOURCE,
    size: (u32, u32),
}

impl<'a> Mapped<'a> {
    fn try_new(gpu: &'a Gpu, texture: &'a ID3D11Texture2D) -> Result<Option<Self>> {
        let mut data = D3D11_MAPPED_SUBRESOURCE::default();
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: staging is used only by this extractor; DO_NOT_WAIT returns immediately if the GPU is not finished.
        unsafe {
            texture.GetDesc(&mut desc);
            match gpu.context.Map(
                texture,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut data),
            ) {
                Ok(()) => Ok(Some(Self {
                    gpu,
                    texture,
                    data,
                    size: (desc.Width, desc.Height),
                })),
                Err(error) if error.code() == DXGI_ERROR_WAS_STILL_DRAWING => Ok(None),
                Err(error) => Err(error).context("Failed to map thumbnail staging texture"),
            }
        }
    }

    fn pixels(&self, gray: bool) -> Vec<u8> {
        let channels = if gray { 1 } else { 3 };
        let mut output = Vec::with_capacity(self.size.0 as usize * self.size.1 as usize * channels);
        for y in 0..self.size.1 as usize {
            // SAFETY: After Map succeeds, each row has at least width * 4 bytes; read valid pixels only and skip RowPitch padding.
            let row = unsafe {
                std::slice::from_raw_parts(
                    self.data
                        .pData
                        .cast::<u8>()
                        .add(y * self.data.RowPitch as usize),
                    self.size.0 as usize * 4,
                )
            };
            convert_row(row, gray, &mut output);
        }
        output
    }
}

impl Drop for Mapped<'_> {
    fn drop(&mut self) {
        // SAFETY: This guard unmaps each successful Map exactly once; texture remains alive while the guard exists.
        unsafe { self.gpu.context.Unmap(self.texture, 0) };
    }
}

fn convert_row(row: &[u8], gray: bool, output: &mut Vec<u8>) {
    for bgra in row.chunks_exact(4) {
        if gray {
            output.push(
                ((299 * bgra[2] as u32 + 587 * bgra[1] as u32 + 114 * bgra[0] as u32) / 1000) as u8,
            );
        } else {
            output.extend_from_slice(&bgra[..3]);
        }
    }
}

fn texture(gpu: &Gpu, size: (u32, u32), staging: bool) -> Result<ID3D11Texture2D> {
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
        Usage: if staging {
            D3D11_USAGE_STAGING
        } else {
            D3D11_USAGE_DEFAULT
        },
        BindFlags: if staging {
            0
        } else {
            (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32
        },
        CPUAccessFlags: if staging {
            D3D11_CPU_ACCESS_READ.0 as u32
        } else {
            0
        },
        ..Default::default()
    };
    let mut result = None;
    // SAFETY: desc fully describes a single-layer BGRA texture; the windows crate manages the output.
    unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut result))? };
    result.context("Creating thumbnail texture returned no object")
}

fn copy_roi(gpu: &Gpu, source: &ID3D11Texture2D, target: &ID3D11Texture2D, roi: [u32; 4]) {
    let r = Rect::from_array(roi);
    let region = D3D11_BOX {
        left: r.x,
        top: r.y,
        front: 0,
        right: r.x + r.w,
        bottom: r.y + r.h,
        back: 1,
    };
    // SAFETY: ROI is validated within the 1920×1080 reference texture; destination staging matches its dimensions and format.
    unsafe {
        gpu.context
            .CopySubresourceRegion(target, 0, 0, 0, 0, source, 0, Some(&region))
    };
}

/// Each scaler has its own processor and views to avoid changing the encoder's D3D11 drawing state.
struct Scaler {
    input_size: (u32, u32),
    input: ID3D11Texture2D,
    output: ID3D11Texture2D,
    input_view: ID3D11VideoProcessorInputView,
    output_view: ID3D11VideoProcessorOutputView,
    processor: ID3D11VideoProcessor,
    context: ID3D11VideoContext,
}

impl Scaler {
    fn new(gpu: &Gpu, input_size: (u32, u32), output_size: (u32, u32)) -> Result<Self> {
        let device: ID3D11VideoDevice = gpu.device.cast()?;
        let context: ID3D11VideoContext = gpu.context.cast()?;
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: SMALL_FPS,
                Denominator: 1,
            },
            InputWidth: input_size.0,
            InputHeight: input_size.1,
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: SMALL_FPS,
                Denominator: 1,
            },
            OutputWidth: output_size.0,
            OutputHeight: output_size.1,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        let input = texture(gpu, input_size, false)?;
        let output = texture(gpu, output_size, false)?;
        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        let mut input_view = None;
        let mut output_view = None;
        // SAFETY: The processor and views all belong to the same device; input and output are single-layer BGRA textures.
        let processor = unsafe {
            let enumerator = device.CreateVideoProcessorEnumerator(&desc)?;
            let support = enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM)?;
            if support & 3 != 3 {
                bail!("GPU VideoProcessor does not support BGRA scaling");
            }
            let processor = device.CreateVideoProcessor(&enumerator, 0)?;
            device.CreateVideoProcessorInputView(
                &input,
                &enumerator,
                &input_desc,
                Some(&mut input_view),
            )?;
            device.CreateVideoProcessorOutputView(
                &output,
                &enumerator,
                &output_desc,
                Some(&mut output_view),
            )?;
            let source = RECT {
                left: 0,
                top: 0,
                right: input_size.0 as i32,
                bottom: input_size.1 as i32,
            };
            let target = RECT {
                left: 0,
                top: 0,
                right: output_size.0 as i32,
                bottom: output_size.1 as i32,
            };
            context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&source));
            context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&target));
            context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&target));
            // Use full-range RGB and disable driver auto-enhancement to preserve the original icon colors for detection.
            let color = D3D11_VIDEO_PROCESSOR_COLOR_SPACE::default();
            context.VideoProcessorSetStreamColorSpace(&processor, 0, &color);
            context.VideoProcessorSetOutputColorSpace(&processor, &color);
            processor
        };
        Ok(Self {
            input_size,
            input,
            output,
            input_view: input_view.context("Missing VideoProcessor input view")?,
            output_view: output_view.context("Missing VideoProcessor output view")?,
            processor,
            context,
        })
    }

    fn scale(&self, gpu: &Gpu, source: &ID3D11Texture2D) -> Result<()> {
        let region = D3D11_BOX {
            right: self.input_size.0,
            bottom: self.input_size.1,
            back: 1,
            ..Default::default()
        };
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: ManuallyDrop::new(Some(self.input_view.clone())),
            ..Default::default()
        };
        // SAFETY: The copy region uses validated frame dimensions; views remain valid during Blt, with no past or future frames used.
        let result = unsafe {
            gpu.context
                .CopySubresourceRegion(&self.input, 0, 0, 0, 0, source, 0, Some(&region));
            self.context.VideoProcessorBlt(
                &self.processor,
                &self.output_view,
                0,
                std::slice::from_ref(&stream),
            )
        };
        // SAFETY: The COM field in stream is ManuallyDrop; release exactly the reference cloned for this call.
        unsafe { ManuallyDrop::drop(&mut stream.pInputSurface) };
        result.context("GPU thumbnail scaling failed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_roi_without_overflow() {
        let valid = FramesSpec {
            banner: [10, 20, 30, 40],
            spec: [0, 0, 1, 1],
            base: [1920, 1080],
            killfeed: None,
        };
        assert!(validate_spec(valid).is_ok());
        assert!(validate_spec(FramesSpec { killfeed: Some([1919, 0, 2, 1]), ..valid }).is_err());
        for roi in [
            [0, 0, 0, 1],
            [1919, 0, 2, 1],
            [0, 1079, 1, 2],
            [u32::MAX, 0, 2, 1],
        ] {
            assert!(validate_spec(FramesSpec {
                banner: roi,
                ..valid
            })
            .is_err());
        }
        assert!(validate_spec(FramesSpec {
            base: [0, 1080],
            ..valid
        })
        .is_err());
    }

    #[test]
    fn converts_bgra_to_packed_bgr_and_gray() {
        let row = [0, 0, 255, 10, 0, 255, 0, 20, 255, 0, 0, 30];
        let mut bgr = Vec::new();
        convert_row(&row, false, &mut bgr);
        assert_eq!(bgr, [0, 0, 255, 0, 255, 0, 255, 0, 0]);
        let mut gray = Vec::new();
        convert_row(&row, true, &mut gray);
        assert_eq!(gray, [76, 149, 29]);
    }
}
