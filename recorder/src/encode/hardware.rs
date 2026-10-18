//! D3D11 表面池與 GPU 格式轉換，不做完整影像的 CPU 讀回。
use std::{ffi::CString, mem::ManuallyDrop};

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

pub(super) struct Hardware {
    pub frames: Buffer,
    pub format: AVPixelFormat,
}
impl Hardware {
    pub fn new(gpu: &Gpu, video: &VideoParams, format: AVPixelFormat) -> Result<Self> {
        // SAFETY: FFmpeg 配置相應 API 的 hwctx；COM into_raw 移交一個參照給 FFmpeg。
        unsafe {
            let device = Buffer::owned(av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA))?;
            let context = &mut *((*device.0).data as *mut AVHWDeviceContext);
            let d3d = &mut *(context.hwctx as *mut AVD3D11VADeviceContext);
            d3d.device = gpu.device.clone().into_raw().cast();
            d3d.device_context = gpu.context.clone().into_raw().cast();
            check(av_hwdevice_ctx_init(device.0), "初始化 D3D11 硬體裝置")?;
            let frames = Buffer::owned(av_hwframe_ctx_alloc(device.0))?;
            let context = &mut *((*frames.0).data as *mut AVHWFramesContext);
            context.format = AV_PIX_FMT_D3D11;
            context.sw_format = format;
            context.width = video.width as i32;
            context.height = video.height as i32;
            // 個別 texture 避免部分 VideoProcessor 不支援 array output view。
            context.initial_pool_size = 0;
            let d3d = &mut *(context.hwctx as *mut AVD3D11VAFramesContext);
            d3d.BindFlags = D3D11_BIND_RENDER_TARGET.0 as u32;
            check(av_hwframe_ctx_init(frames.0), "初始化 D3D11 表面池")?;
            Ok(Self { frames, format })
        }
    }
    pub fn surface(&self) -> Result<Frame> {
        let frame = Frame::new()?;
        // SAFETY: 已初始化的硬體池及空白影格；成功後由影格持有表面參照。
        unsafe {
            check(
                av_hwframe_get_buffer(self.frames.0, frame.0, 0),
                "配置 GPU 表面",
            )?;
        }
        Ok(frame)
    }
    pub fn encoder(&self, name: &str, video: &VideoParams) -> Result<Encoder> {
        let name_c = CString::new(name)?;
        let encoder = Encoder::allocate(&name_c)?;
        let qsv_frames = if name.ends_with("_qsv") {
            // SAFETY: 從既有 D3D11 裝置衍生 QSV；失敗時也由 Buffer 收回已配置的參照。
            unsafe {
                let mut qsv = Buffer(std::ptr::null_mut());
                let device = (*((*self.frames.0).data as *mut AVHWFramesContext)).device_ref;
                check(
                    av_hwdevice_ctx_create_derived(&mut qsv.0, AV_HWDEVICE_TYPE_QSV, device, 0),
                    "建立 QSV 衍生裝置",
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
                    "建立 QSV 衍生表面池",
                )?;
                Some(frames)
            }
        } else {
            None
        };
        // SAFETY: 尚未開啟、由本函式獨佔的編碼 context；參照由 context 釋放。
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
        if name.ends_with("_nvenc") {
            encoder.option(c"preset", c"p1")?;
            encoder.option(c"tune", c"ull")?;
            encoder.option(c"zerolatency", c"1")?;
            encoder.option(c"forced-idr", c"1")?;
            encoder.option(c"no-scenecut", c"1")?;
            encoder.option(c"rc-lookahead", c"0")?;
        } else if name.ends_with("_amf") {
            encoder.option(c"usage", c"ultralowlatency")?;
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
}
struct Processor {
    source: (u32, u32),
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
        }
    }
    pub fn copy(
        &mut self,
        source: &ID3D11Texture2D,
        size: (u32, u32),
        frame: &Frame,
    ) -> Result<()> {
        // SAFETY: frame 是 D3D11 hwframe，data[0] 為有效 texture，from_raw_borrowed 不取得擁有權。
        let target = unsafe {
            let raw = (*frame.0).data[0].cast();
            ID3D11Texture2D::from_raw_borrowed(&raw)
                .context("GPU 影格沒有 texture")?
                .clone()
        };
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: 有效 texture 及可寫的描述；後續確認尺寸及來源格式。
        unsafe {
            source.GetDesc(&mut desc);
        }
        // SAFETY: texture 持有來源裝置；比較 COM identity，避免跨裝置複製被 D3D11 靜默忽略。
        let source_device = unsafe { source.GetDevice()? };
        ensure!(
            source_device == self.gpu.device,
            "來源 texture 不屬於共用 GPU 裝置"
        );
        ensure!(
            size == (desc.Width, desc.Height)
                && desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM
                && desc.SampleDesc.Count == 1,
            "來源 texture 尺寸或 BGRA 格式不符"
        );
        if size == (self.width, self.height) && self.format == AV_PIX_FMT_BGRA {
            // SAFETY: 來源與目標同尺寸同格式，彼此獨立且裝置相同。
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
            )?);
        }
        let processor = self.processor.as_ref().context("GPU 縮放器未建立")?;
        processor.copy(source, &target)
    }
}
impl Processor {
    fn new(
        gpu: &Gpu,
        source: (u32, u32),
        target: (u32, u32),
        format: AVPixelFormat,
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
        // SAFETY: 描述與矩形在呼叫期間有效；processor 與 context 屬於相同裝置。
        unsafe {
            let enumerator = device.CreateVideoProcessorEnumerator(&desc)?;
            let processor = device.CreateVideoProcessor(&enumerator, 0)?;
            context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            // 關閉驅動的自動對比／色彩增強，避免 GPU 縮放改變原始遊戲色彩。
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
            context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&dst));
            context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&dst));
            // RGB 輸入全範圍，NV12 輸出採 BT.709／有限範圍。
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
                device,
                context,
                enumerator,
                processor,
            })
        }
    }
    fn copy(&self, source: &ID3D11Texture2D, target: &ID3D11Texture2D) -> Result<()> {
        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        let mut input = None;
        let mut output = None;
        // SAFETY: 所有 view 與 processor 使用相同裝置，描述指定 texture2D 的第 0 層。
        unsafe {
            self.device.CreateVideoProcessorInputView(
                source,
                &self.enumerator,
                &input_desc,
                Some(&mut input),
            )?;
            self.device.CreateVideoProcessorOutputView(
                target,
                &self.enumerator,
                &output_desc,
                Some(&mut output),
            )?;
        }
        let output = output.context("沒有輸出 view")?;
        let input = input.context("沒有輸入 view")?;
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: ManuallyDrop::new(Some(input)),
            ..Default::default()
        };
        // SAFETY: 有效的 input/output view；呼叫完成後明確釋放 ManuallyDrop 中的參照。
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
        result.context("GPU 縮放／NV12 轉換失敗")
    }
}
