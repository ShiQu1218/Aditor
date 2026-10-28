//! D3D11 frame pool and GPU format conversion without reading full images back to the CPU.
use std::{
    ffi::{CStr, CString},
    mem::ManuallyDrop,
};

use anyhow::{ensure, Context, Result};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice,
};
use windows::{
    core::Interface,
    Win32::{
        Foundation::RECT,
        Graphics::{Direct3D11::*, Dxgi::Common::*},
    },
};

use super::{
    ffi::*,
    ffmpeg::{check, Buffer, Encoder, Frame, TICK_BASE},
    VideoParams,
};
use crate::gpu::Gpu;
use crate::types::{EncodeAspect, EncodePreset};

fn preset_option(name: &str, preset: EncodePreset) -> Option<(&'static CStr, &'static CStr)> {
    let index = match preset {
        EncodePreset::Speed => 0,
        EncodePreset::Balanced => 1,
        EncodePreset::Quality => 2,
    };
    if name.ends_with("_nvenc") {
        Some((c"preset", [c"p1", c"p4", c"p7"][index]))
    } else if name.ends_with("_amf") {
        Some((c"quality", [c"speed", c"balanced", c"quality"][index]))
    } else if name.ends_with("_qsv") {
        Some((c"preset", [c"veryfast", c"medium", c"veryslow"][index]))
    } else {
        None
    }
}

fn aspect_rect(source: (u32, u32), target: (u32, u32), aspect: EncodeAspect) -> RECT {
    let (mut width, mut height) = target;
    if aspect == EncodeAspect::Fit && u64::from(source.0) * 9 != u64::from(source.1) * 16 {
        if u64::from(source.0) * u64::from(target.1) > u64::from(target.0) * u64::from(source.1) {
            height = ((u64::from(target.0) * u64::from(source.1) / u64::from(source.0)) as u32
                & !1)
                .max(2);
        } else {
            width = ((u64::from(target.1) * u64::from(source.0) / u64::from(source.1)) as u32 & !1)
                .max(2);
        }
    }
    // NV12 positions and dimensions are aligned to chroma samples; odd margins are left on the right/bottom.
    let left = ((target.0 - width) / 2) & !1;
    let top = ((target.1 - height) / 2) & !1;
    RECT {
        left: left as i32,
        top: top as i32,
        right: (left + width) as i32,
        bottom: (top + height) as i32,
    }
}

pub(super) struct Hardware {
    pub frames: Buffer,
    pub format: AVPixelFormat,
}
impl Hardware {
    pub fn new(gpu: &Gpu, video: &VideoParams, format: AVPixelFormat) -> Result<Self> {
        super::ffmpeg::check_version()?;
        // SAFETY: FFmpeg allocates the hardware context through its API; COM into_raw transfers one reference to FFmpeg.
        unsafe {
            let device = Buffer::owned(av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA))?;
            let context = &mut *((*device.0).data as *mut AVHWDeviceContext);
            let d3d = &mut *(context.hwctx as *mut AVD3D11VADeviceContext);
            d3d.device = gpu.device.clone().into_raw().cast();
            d3d.device_context = gpu.context.clone().into_raw().cast();
            check(
                av_hwdevice_ctx_init(device.0),
                "Initialize D3D11 hardware device",
            )?;
            let frames = Buffer::owned(av_hwframe_ctx_alloc(device.0))?;
            let context = &mut *((*frames.0).data as *mut AVHWFramesContext);
            context.format = AV_PIX_FMT_D3D11;
            context.sw_format = format;
            context.width = video.width as i32;
            context.height = video.height as i32;
            // Use individual textures because some VideoProcessors do not support array output views.
            context.initial_pool_size = 0;
            let d3d = &mut *(context.hwctx as *mut AVD3D11VAFramesContext);
            d3d.BindFlags = D3D11_BIND_RENDER_TARGET.0 as u32;
            check(av_hwframe_ctx_init(frames.0), "Initialize D3D11 frame pool")?;
            Ok(Self { frames, format })
        }
    }
    pub fn surface(&self) -> Result<Frame> {
        let frame = Frame::new()?;
        // SAFETY: The hardware pool and empty frame are initialized; on success the frame owns a surface reference.
        unsafe {
            check(
                av_hwframe_get_buffer(self.frames.0, frame.0, 0),
                "Allocate GPU surface",
            )?;
            if self.format == AV_PIX_FMT_NV12 {
                (*frame.0).color_range = AVCOL_RANGE_MPEG;
                (*frame.0).colorspace = AVCOL_SPC_BT709;
                (*frame.0).color_primaries = AVCOL_PRI_BT709;
                (*frame.0).color_trc = AVCOL_TRC_BT709;
            }
        }
        Ok(frame)
    }
    pub fn encoder(&self, name: &str, video: &VideoParams) -> Result<Encoder> {
        let name_c = CString::new(name)?;
        let encoder = Encoder::allocate(&name_c)?;
        let qsv_frames = if name.ends_with("_qsv") {
            // SAFETY: Derive QSV from the existing D3D11 device; Buffer reclaims allocated references on failure.
            unsafe {
                let mut qsv = Buffer(std::ptr::null_mut());
                let device = (*((*self.frames.0).data as *mut AVHWFramesContext)).device_ref;
                check(
                    av_hwdevice_ctx_create_derived(&mut qsv.0, AV_HWDEVICE_TYPE_QSV, device, 0),
                    "Create derived QSV device",
                )?;
                let mut frames = Buffer(std::ptr::null_mut());
                check(
                    av_hwframe_ctx_create_derived(
                        &mut frames.0,
                        AV_PIX_FMT_QSV,
                        qsv.0,
                        self.frames.0,
                        AV_HWFRAME_MAP_READ,
                    ),
                    "Create derived QSV frame pool",
                )?;
                Some(frames)
            }
        } else {
            None
        };
        // SAFETY: The unopened encoding context is exclusively owned by this function; the context releases its references.
        unsafe {
            let context = &mut *encoder.0;
            context.width = video.width as i32;
            context.height = video.height as i32;
            context.pix_fmt = if qsv_frames.is_some() {
                AV_PIX_FMT_QSV
            } else {
                AV_PIX_FMT_D3D11
            };
            context.time_base = TICK_BASE;
            context.framerate = AVRational {
                num: video.fps as i32,
                den: 1,
            };
            context.bit_rate = video.bitrate_kbps as i64 * 1000;
            context.gop_size = (video.fps * 2) as i32;
            context.max_b_frames = 0;
            context.color_range = AVCOL_RANGE_MPEG;
            context.colorspace = AVCOL_SPC_BT709;
            context.color_primaries = AVCOL_PRI_BT709;
            context.color_trc = AVCOL_TRC_BT709;
            context.flags |= AV_CODEC_FLAG_GLOBAL_HEADER as i32;
            context.hw_frames_ctx = qsv_frames.as_ref().unwrap_or(&self.frames).reference()?;
        }
        if let Some((option, value)) = preset_option(name, video.preset) {
            encoder.option(option, value)?;
        }
        if name.ends_with("_nvenc") {
            encoder.option(c"tune", c"ull")?;
            encoder.option(c"zerolatency", c"1")?;
            encoder.option(c"forced-idr", c"1")?;
            encoder.option(c"no-scenecut", c"1")?;
            encoder.option(c"rc-lookahead", c"0")?;
        } else if name.ends_with("_amf") {
            encoder.option(c"usage", c"ultralowlatency")?;
            encoder.option(c"forced_idr", c"1")?;
        } else if name.ends_with("_qsv") {
            encoder.option(c"async_depth", c"1")?;
            encoder.option(c"forced_idr", c"1")?;
        }
        encoder.open()?;
        Ok(encoder)
    }
}

pub(super) struct Copier {
    gpu: Gpu,
    width: u32,
    height: u32,
    format: AVPixelFormat,
    processor: Option<Processor>,
    aspect: EncodeAspect,
}
struct Processor {
    source: (u32, u32),
    gpu: Gpu,
    /// Copy of sources that cannot back a video-processor input view (e.g. shader-resource-only).
    fallback: Option<(ID3D11Texture2D, ID3D11VideoProcessorInputView)>,
    device: ID3D11VideoDevice,
    context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
}
impl Copier {
    pub fn new(gpu: &Gpu, video: &VideoParams, format: AVPixelFormat) -> Self {
        Self {
            gpu: gpu.clone(),
            width: video.width,
            height: video.height,
            format,
            processor: None,
            aspect: video.aspect,
        }
    }
    pub fn copy(
        &mut self,
        source: &ID3D11Texture2D,
        size: (u32, u32),
        frame: &Frame,
    ) -> Result<()> {
        // SAFETY: frame is a D3D11 hwframe, data[0] is a valid texture, and from_raw_borrowed does not take ownership.
        let target = unsafe {
            let raw = (*frame.0).data[0].cast();
            ID3D11Texture2D::from_raw_borrowed(&raw)
                .context("GPU frame has no texture")?
                .clone()
        };
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: The texture is valid and the description is writable; dimensions and source format are checked next.
        unsafe {
            source.GetDesc(&mut desc);
        }
        // SAFETY: The texture retains its source device; compare COM identity to avoid D3D11 silently ignoring cross-device copies.
        let source_device = unsafe { source.GetDevice()? };
        ensure!(
            source_device == self.gpu.device,
            "Source texture does not belong to the shared GPU device"
        );
        ensure!(
            size == (desc.Width, desc.Height)
                && desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM
                && desc.SampleDesc.Count == 1,
            "Source texture dimensions or BGRA format do not match"
        );
        if size == (self.width, self.height) && self.format == AV_PIX_FMT_BGRA {
            // SAFETY: Source and destination have matching dimensions and formats, are distinct, and use the same device.
            unsafe {
                self.gpu
                    .context
                    .CopySubresourceRegion(&target, 0, 0, 0, 0, source, 0, None);
            }
            return Ok(());
        }
        if self.processor.as_ref().is_none_or(|p| p.source != size) {
            self.processor = Some(Processor::new(
                &self.gpu,
                size,
                (self.width, self.height),
                self.format,
                self.aspect,
            )?);
        }
        let processor = self
            .processor
            .as_mut()
            .context("GPU scaler was not created")?;
        processor.copy(source, &target)
    }
}
impl Processor {
    fn new(
        gpu: &Gpu,
        source: (u32, u32),
        target: (u32, u32),
        format: AVPixelFormat,
        aspect: EncodeAspect,
    ) -> Result<Self> {
        let device: ID3D11VideoDevice = gpu.device.cast()?;
        let context: ID3D11VideoContext = gpu.context.cast()?;
        let color_context: ID3D11VideoContext1 = gpu.context.cast()?;
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: 60,
                Denominator: 1,
            },
            InputWidth: source.0,
            InputHeight: source.1,
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: 60,
                Denominator: 1,
            },
            OutputWidth: target.0,
            OutputHeight: target.1,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        // SAFETY: The description and rectangles remain valid for the call; processor and context belong to the same device.
        unsafe {
            let enumerator = device.CreateVideoProcessorEnumerator(&desc)?;
            let processor = device.CreateVideoProcessor(&enumerator, 0)?;
            context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            // Disable driver auto-contrast/color enhancement to keep GPU scaling from changing the original game colors.
            context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            let src = RECT {
                left: 0,
                top: 0,
                right: source.0 as i32,
                bottom: source.1 as i32,
            };
            let dst = RECT {
                left: 0,
                top: 0,
                right: target.0 as i32,
                bottom: target.1 as i32,
            };
            context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&src));
            let content = aspect_rect(source, target, aspect);
            context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&content));
            context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&dst));
            context.VideoProcessorSetOutputBackgroundColor(
                &processor,
                false,
                &D3D11_VIDEO_COLOR {
                    Anonymous: D3D11_VIDEO_COLOR_0 {
                        RGBA: D3D11_VIDEO_COLOR_RGBA {
                            R: 0.0,
                            G: 0.0,
                            B: 0.0,
                            A: 1.0,
                        },
                    },
                },
            );
            // RGB input uses full range; NV12 output uses BT.709/limited range.
            color_context.VideoProcessorSetStreamColorSpace1(
                &processor,
                0,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
            color_context.VideoProcessorSetOutputColorSpace1(
                &processor,
                if format == AV_PIX_FMT_NV12 {
                    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709
                } else {
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709
                },
            );
            Ok(Self {
                source,
                gpu: gpu.clone(),
                fallback: None,
                device,
                context,
                enumerator,
                processor,
            })
        }
    }
    fn input_view(&self, texture: &ID3D11Texture2D) -> Result<ID3D11VideoProcessorInputView> {
        let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        let mut view = None;
        // SAFETY: The texture and enumerator use the same device; the description selects mip 0 of a texture2D.
        unsafe {
            self.device.CreateVideoProcessorInputView(
                texture,
                &self.enumerator,
                &desc,
                Some(&mut view),
            )?;
        }
        view.context("Missing input view")
    }
    /// Copies the source into a private render-target texture that can back an input view.
    fn fallback_input(
        &mut self,
        source: &ID3D11Texture2D,
    ) -> Result<ID3D11VideoProcessorInputView> {
        if self.fallback.is_none() {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: self.source.0,
                Height: self.source.1,
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
            let mut texture = None;
            // SAFETY: Valid device and single-mip BGRA description; the windows crate manages the output reference.
            unsafe {
                self.gpu
                    .device
                    .CreateTexture2D(&desc, None, Some(&mut texture))?
            };
            let texture = texture.context("Missing video processor fallback texture")?;
            let view = self.input_view(&texture)?;
            self.fallback = Some((texture, view));
        }
        let (texture, view) = self.fallback.as_ref().context("Missing fallback input")?;
        // SAFETY: Same device, size and BGRA format as the validated source; the copy is ordered before the Blt.
        unsafe { self.gpu.context.CopyResource(texture, source) };
        Ok(view.clone())
    }
    fn copy(&mut self, source: &ID3D11Texture2D, target: &ID3D11Texture2D) -> Result<()> {
        let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        let mut output = None;
        // SAFETY: The target and enumerator use the same device; the description selects mip 0 of a texture2D.
        unsafe {
            self.device.CreateVideoProcessorOutputView(
                target,
                &self.enumerator,
                &output_desc,
                Some(&mut output),
            )?;
        }
        let output = output.context("Missing output view")?;
        let input = match self.input_view(source) {
            Ok(view) => view,
            Err(_) => self.fallback_input(source)?,
        };
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: ManuallyDrop::new(Some(input)),
            ..Default::default()
        };
        // SAFETY: Input and output views are valid; explicitly release the ManuallyDrop references after the call.
        let result = unsafe {
            let result = self.context.VideoProcessorBlt(
                &self.processor,
                &output,
                0,
                std::slice::from_ref(&stream),
            );
            ManuallyDrop::drop(&mut stream.pInputSurface);
            result
        };
        result.context("GPU scaling/NV12 conversion failed")
    }
}

#[cfg(test)]
mod settings_tests {
    use super::*;
    use crate::types::{EncodeAspect, EncodePreset};

    #[test]
    fn bundled_ffmpeg_accepts_forced_idr_for_all_amf_codecs() {
        // Allocating a context and setting AVOptions does not require an AMD GPU.
        for name in [c"h264_amf", c"hevc_amf", c"av1_amf"] {
            let encoder = Encoder::allocate(name).unwrap();
            encoder.option(c"forced_idr", c"1").unwrap_or_else(|error| {
                panic!("{} must accept forced_idr: {error}", name.to_string_lossy())
            });
        }
    }

    #[test]
    fn presets_match_each_hardware_family() {
        for (preset, nvenc, amf, qsv) in [
            (EncodePreset::Speed, c"p1", c"speed", c"veryfast"),
            (EncodePreset::Balanced, c"p4", c"balanced", c"medium"),
            (EncodePreset::Quality, c"p7", c"quality", c"veryslow"),
        ] {
            assert_eq!(
                preset_option("hevc_nvenc", preset),
                Some((c"preset", nvenc))
            );
            assert_eq!(preset_option("h264_amf", preset), Some((c"quality", amf)));
            assert_eq!(preset_option("av1_qsv", preset), Some((c"preset", qsv)));
        }
    }

    #[test]
    fn fit_centers_wide_and_tall_sources_while_stretch_fills_output() {
        for (source, expected) in [
            ((2520, 1080), (0, 128, 1920, 950)),
            ((3840, 1080), (0, 270, 1920, 810)),
            ((1920, 1200), (96, 0, 1824, 1080)),
            ((1440, 1080), (240, 0, 1680, 1080)),
            ((1920, 1080), (0, 0, 1920, 1080)),
        ] {
            let rect = aspect_rect(source, (1920, 1080), EncodeAspect::Fit);
            assert_eq!((rect.left, rect.top, rect.right, rect.bottom), expected);
            for mode in [EncodeAspect::Native, EncodeAspect::Stretch] {
                let rect = aspect_rect(source, (1920, 1080), mode);
                assert_eq!(
                    (rect.left, rect.top, rect.right, rect.bottom),
                    (0, 0, 1920, 1080)
                );
            }
        }
        let rect = aspect_rect((1920, 1080), (1066, 600), EncodeAspect::Fit);
        assert_eq!(
            (rect.left, rect.top, rect.right, rect.bottom),
            (0, 0, 1066, 600)
        );
    }
}
