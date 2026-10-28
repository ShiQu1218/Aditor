//! Hardware encoding and fMP4 segments (task B1). Uses the bundled LGPL FFmpeg DLL through generated ffi bindings:
//! D3D11 hwframes with NVENC/AMF/QSV, AAC audio, and an init.mp4 plus two-second seg_NNNNNN.m4s segments (GOP-aligned per spec §2.1).
//! Packages output as init.mp4 and a seg_NNNNNN.m4s every two seconds (GOP aligned per spec 2.1).
//!
//! The interface is fixed by the scaffold; implementations must not change its signatures.

mod aac;
pub mod ffi;
mod ffmpeg;
mod hardware;
mod mux;
mod nvenc;

use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender, TryRecvError},
        Arc, Mutex, OnceLock, TryLockError,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use anyhow::{bail, ensure, Context, Result};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

use crate::gpu::Gpu;
use crate::types::{Codec, EncodeAspect, EncodePreset};
pub(crate) use ffmpeg::check_version;
use ffmpeg::{Encoder, Frame};
use hardware::{Copier, Hardware};

/// Hardware encoders in automatic selection order; the IPC protocol reports unions in this order.
pub(crate) const ENCODERS: [&str; 9] = [
    "hevc_nvenc",
    "h264_nvenc",
    "av1_nvenc",
    "hevc_amf",
    "h264_amf",
    "av1_amf",
    "hevc_qsv",
    "h264_qsv",
    "av1_qsv",
];
const QUEUE_SIZE: usize = 8;
const POOL_SIZE: usize = 12;

#[derive(Debug, Clone, PartialEq)]
pub struct VideoParams {
    /// Output dimensions (must be even).Scale on the GPU when source dimensions differ.
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Codec,
    /// The value auto or an explicit encoder name.
    pub encoder: String,
    pub bitrate_kbps: u32,
    pub preset: EncodePreset,
    pub aspect: EncodeAspect,
}

/// Sent after a segment is written, flushed, and fsynced.
#[derive(Debug, Clone, PartialEq)]
pub struct SegmentInfo {
    pub seq: u64,
    pub pts_secs: f64,
    pub dur_secs: f64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EncodeStats {
    pub frames_in: u64,
    pub frames_encoded: u64,
    pub dropped: u64,
    pub queue_len: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushResult {
    Queued,
    /// Queue full; drop this frame (counted in dropped).
    Dropped,
}

pub struct SegmentWriter {
    name: String,
    producer: Mutex<Producer>,
    video_tx: Option<SyncSender<VideoJob>>,
    audio_tx: Option<SyncSender<AudioJob>>,
    counts: Arc<Counts>,
    worker: Option<JoinHandle<Result<()>>>,
}

#[derive(Default)]
struct Counts {
    input: AtomicU64,
    encoded: AtomicU64,
    dropped: AtomicU64,
    queue: AtomicU64,
    audio_dropped: AtomicU64,
    error: OnceLock<String>,
}
impl Counts {
    fn fail(&self, error: impl std::fmt::Display) {
        let _ = self.error.set(format!("{error:#}"));
    }

    fn check_error(&self) -> Result<()> {
        if let Some(error) = self.error.get() {
            bail!("encode_failed: {error}");
        }
        Ok(())
    }
}
struct Surface {
    frame: Frame,
}
// SAFETY: The base AVFrame fields are immutable; the worker only clones references, and the producer reuses a texture only when unreferenced.
unsafe impl Sync for Surface {}
struct Producer {
    copier: Copier,
    pool: Vec<Arc<Surface>>,
    last_slot: Option<i64>,
    fps: u32,
}
struct VideoJob {
    surface: Arc<Surface>,
    slot: i64,
}
struct AudioJob {
    samples: Vec<f32>,
    pts: i64,
}

/// Encoder names tried for a codec and encoder setting, in automatic selection order.
pub(crate) fn candidate_names(codec: Codec, encoder: &str) -> Vec<&'static str> {
    if encoder != "auto" {
        return ENCODERS
            .iter()
            .copied()
            .filter(|name| *name == encoder && codec_of(name) == codec)
            .collect();
    }
    let mut names: Vec<_> = ENCODERS
        .iter()
        .copied()
        .filter(|name| codec_of(name) == codec)
        .collect();
    if codec == Codec::Hevc {
        names.extend(
            ENCODERS
                .iter()
                .copied()
                .filter(|name| codec_of(name) == Codec::H264),
        );
    }
    names
}
fn candidates(video: &VideoParams) -> Vec<&'static str> {
    candidate_names(video.codec, &video.encoder)
}
pub(crate) fn codec_of(name: &str) -> Codec {
    if name.starts_with("hevc_") {
        Codec::Hevc
    } else if name.starts_with("av1_") {
        Codec::Av1
    } else {
        Codec::H264
    }
}
fn input_formats(name: &str) -> [ffi::AVPixelFormat; 2] {
    if name.ends_with("_nvenc") {
        [ffi::AV_PIX_FMT_NV12, ffi::AV_PIX_FMT_BGRA]
    } else {
        [ffi::AV_PIX_FMT_BGRA, ffi::AV_PIX_FMT_NV12]
    }
}

fn probe(gpu: &Gpu, name: &str) -> Result<ffi::AVPixelFormat> {
    let params = VideoParams {
        width: 256,
        height: 144,
        fps: 60,
        codec: codec_of(name),
        encoder: name.into(),
        bitrate_kbps: 1000,
        preset: EncodePreset::Speed,
        aspect: EncodeAspect::Native,
    };
    let mut failure = None;
    for format in input_formats(name) {
        let attempt = || -> Result<()> {
            let hardware = Hardware::new(gpu, &params, format)?;
            let encoder = hardware.encoder(name, &params)?;
            let frame = hardware.surface()?;
            // Exercise the BGRA-to-surface copy too: NV12 always goes through the video processor,
            // which the encoder alone does not test.
            let source = probe_source(gpu, (params.width, params.height))?;
            Copier::new(gpu, &params, format).copy(
                &source,
                (params.width, params.height),
                &frame,
            )?;
            // SAFETY: This thread exclusively owns the frame and sets its initial encoding timestamp.
            unsafe {
                (*frame.0).pts = 0;
            }
            let packets = encoder.send(Some(&frame))?;
            let tail = encoder.send(None)?;
            ensure!(
                !packets.is_empty() || !tail.is_empty(),
                "Trial encoding produced no packets"
            );
            Ok(())
        };
        match attempt() {
            Ok(()) => return Ok(format),
            Err(error) => failure = Some(error),
        }
    }
    let failure = failure.unwrap_or_else(|| anyhow::anyhow!("No pixel format was tried"));
    Err(failure.context("Trial encoding failed"))
}

/// A blank BGRA render-target texture shaped like a captured frame.
fn probe_source(gpu: &Gpu, size: (u32, u32)) -> Result<ID3D11Texture2D> {
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
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
        ..Default::default()
    };
    let mut texture = None;
    // SAFETY: Valid device and single-mip BGRA description; the windows crate manages the output reference.
    unsafe {
        gpu.device
            .CreateTexture2D(&desc, None, Some(&mut texture))?
    };
    texture.context("Probe texture was not created")
}

/// Builds the no_hw_encoder message; flags an outdated NVIDIA driver so the app can show an update hint.
/// IPC contract: the app matches the `nvidia_driver_outdated` marker (app/src/main/recording/session.ts).
/// FFmpeg also returns ENOSYS for GPUs or codecs NVENC does not support, so the driver is queried only to confirm.
fn no_hw_encoder_message(
    failures: &[(&str, anyhow::Error)],
    driver_api: impl FnOnce() -> Option<(u32, u32)>,
) -> String {
    let details = failures
        .iter()
        .map(|(name, error)| format!("{name}: {error:#}"))
        .collect::<Vec<_>>()
        .join("；");
    let nvenc_unsupported = failures.iter().any(|(name, error)| {
        name.ends_with("_nvenc") && ffmpeg::error_code(error) == Some(ffmpeg::NOT_IMPLEMENTED)
    });
    let outdated = nvenc_unsupported
        .then(driver_api)
        .flatten()
        .filter(|api| *api < nvenc::REQUIRED_API);
    match outdated {
        Some((major, minor)) => {
            let (required_major, required_minor) = nvenc::REQUIRED_API;
            format!(
                "no_hw_encoder: nvidia_driver_outdated: The NVIDIA driver supports NVENC API {major}.{minor} but {required_major}.{required_minor} is required; update the NVIDIA driver to {} or newer and try again (GPUs whose newest driver is older cannot use NVENC); {details}",
                nvenc::MIN_DRIVER
            )
        }
        None => format!("no_hw_encoder: No hardware encoder is available; {details}"),
    }
}

impl SegmentWriter {
    /// Tries each hardware encoder with a small test frame and returns available names, such as hevc_nvenc and h264_nvenc.
    pub fn probe_encoders(gpu: &Gpu) -> Vec<String> {
        Self::probe_encoders_where(gpu, |_| true)
    }

    /// Tries only encoders in `family` (for example, `nvenc`); `None` probes nothing.
    pub fn probe_encoders_for_family(gpu: &Gpu, family: Option<&str>) -> Vec<String> {
        let Some(family) = family else {
            return Vec::new();
        };
        let suffix = format!("_{family}");
        Self::probe_encoders_where(gpu, |name| name.ends_with(&suffix))
    }

    /// Whether any of `names` passes a trial encode; stops at the first success.
    pub fn supports_any(gpu: &Gpu, names: &[&str]) -> bool {
        names.iter().any(|name| probe(gpu, name).is_ok())
    }

    fn probe_encoders_where(gpu: &Gpu, keep: impl Fn(&str) -> bool) -> Vec<String> {
        ENCODERS
            .iter()
            .filter(|name| keep(name) && probe(gpu, name).is_ok())
            .map(|name| (*name).to_owned())
            .collect()
    }

    /// Opens the encoder and muxer and writes init.mp4. When audio is true, creates a 48 kHz stereo AAC track.
    /// Returns an error if no hardware encoder is available (message contains no_hw_encoder).
    pub fn open(
        gpu: &Gpu,
        dir: &Path,
        video: VideoParams,
        audio: bool,
        on_segment: Sender<SegmentInfo>,
    ) -> Result<Self> {
        check_version()?;
        ensure!(
            video.width >= 2
                && video.height >= 2
                && video.width <= 16_384
                && video.height <= 16_384
                && video.width.is_multiple_of(2)
                && video.height.is_multiple_of(2),
            "Output dimensions must be even and between 2 and 16384"
        );
        ensure!(
            (1..=144).contains(&video.fps) && (1..=1_000_000).contains(&video.bitrate_kbps),
            "FPS or bitrate is outside the supported range"
        );
        let mut selected = None;
        let mut failures = Vec::new();
        for name in candidates(&video) {
            let attempt = || -> Result<_> {
                let format = probe(gpu, name)?;
                let mut failure = None;
                // The recording size can reject a format that passed the small probe.
                for candidate in std::iter::once(format).chain(
                    input_formats(name)
                        .into_iter()
                        .filter(|candidate| *candidate != format),
                ) {
                    let attempt = || -> Result<_> {
                        let hardware = Hardware::new(gpu, &video, candidate)?;
                        let encoder = hardware.encoder(name, &video)?;
                        Ok((hardware, encoder))
                    };
                    match attempt() {
                        Ok(selected) => return Ok(selected),
                        Err(error) => failure = Some(error),
                    }
                }
                Err(failure.context("No recording pixel format was tried")?)
            };
            match attempt() {
                Ok((hardware, encoder)) => {
                    selected = Some((name.to_owned(), hardware, encoder));
                    break;
                }
                Err(error) => failures.push((name, error)),
            }
        }
        let Some((name, hardware, encoder)) = selected else {
            bail!(no_hw_encoder_message(&failures, nvenc::driver_api));
        };
        let mut pool = Vec::with_capacity(POOL_SIZE);
        for _ in 0..POOL_SIZE {
            pool.push(Arc::new(Surface {
                frame: hardware.surface()?,
            }));
        }
        let audio = audio.then(aac::Audio::new).transpose()?;
        let muxer = mux::Muxer::new(
            dir,
            &encoder,
            audio.as_ref().map(|a| &a.encoder),
            on_segment,
        )?;
        let (video_tx, video_rx) = mpsc::sync_channel(QUEUE_SIZE);
        let (audio_tx, audio_rx) = mpsc::sync_channel(64);
        let counts = Arc::new(Counts::default());
        let muxer = mux::MuxWorker::new(muxer, counts.clone())?;
        let worker_counts = counts.clone();
        let fps = video.fps;
        let worker = thread::Builder::new()
            .name("aditorrec-encode".into())
            .spawn(move || {
                monitor_worker(&worker_counts, || {
                    run_worker(
                        encoder,
                        audio,
                        muxer,
                        video_rx,
                        audio_rx,
                        worker_counts.clone(),
                        fps,
                    )
                })
            })
            .context("Failed to create encoder thread")?;
        Ok(Self {
            name,
            producer: Mutex::new(Producer {
                copier: Copier::new(gpu, &video, hardware.format),
                pool,
                last_slot: None,
                fps,
            }),
            video_tx: Some(video_tx),
            audio_tx: Some(audio_tx),
            counts,
            worker: Some(worker),
        })
    }

    /// Name of the encoder actually used.
    pub fn encoder_name(&self) -> &str {
        &self.name
    }

    /// Called by the capture thread: returns immediately after queuing a GPU copy into the internal pool; must not block.
    pub fn push_video(
        &self,
        texture: &ID3D11Texture2D,
        src_w: u32,
        src_h: u32,
        pts: i64,
    ) -> PushResult {
        self.counts.input.fetch_add(1, Ordering::Relaxed);
        let result = || -> Option<()> {
            let mut producer = match self.producer.try_lock() {
                Ok(producer) => producer,
                Err(TryLockError::WouldBlock) => return None,
                Err(TryLockError::Poisoned(_)) => {
                    self.counts.fail("GPU surface pool lock is poisoned");
                    return None;
                }
            };
            if pts < 0
                || self.counts.error.get().is_some()
                || self.counts.queue.load(Ordering::Relaxed) >= QUEUE_SIZE as u64
            {
                return None;
            }
            let slot = ((pts as i128 * producer.fps as i128 + 5_000_000) / 10_000_000) as i64;
            if producer.last_slot.is_some_and(|last| slot <= last) {
                return None;
            }
            let surface = producer
                .pool
                .iter()
                .find(|surface| {
                    if Arc::strong_count(surface) != 1 {
                        return false;
                    }
                    // SAFETY: The base frame remains valid; atomically read AVBuffer reference counts to avoid reusing a surface still held by the encoder.
                    unsafe { ffi::av_buffer_get_ref_count((*surface.frame.0).buf[0]) == 1 }
                })?
                .clone();
            if let Err(error) = producer
                .copier
                .copy(texture, (src_w, src_h), &surface.frame)
            {
                self.counts
                    .fail(format!("GPU frame copy failed: {error:#}"));
                return None;
            }
            self.counts.queue.fetch_add(1, Ordering::Relaxed);
            match self.video_tx.as_ref()?.try_send(VideoJob { surface, slot }) {
                Ok(()) => {}
                Err(_) => {
                    // Disconnected only happens after the worker failed; monitor_worker records that error once the
                    // worker's muxer has flushed, so recording a generic error here would mask the real cause.
                    self.counts.queue.fetch_sub(1, Ordering::Relaxed);
                    return None;
                }
            }
            producer.last_slot = Some(slot);
            Some(())
        };
        if result().is_some() {
            PushResult::Queued
        } else {
            self.counts.dropped.fetch_add(1, Ordering::Relaxed);
            PushResult::Dropped
        }
    }

    /// Called by the audio thread with 48 kHz interleaved stereo f32; pts is the first sample tick.
    pub fn push_audio(&self, interleaved: &[f32], pts: i64) {
        if self.counts.error.get().is_some() {
            return;
        }
        // Each chunk is limited to one second to bound copies from abnormal calls; audio gaps are filled with silence based on the next QPC timestamp.
        if interleaved.is_empty()
            || !interleaved.len().is_multiple_of(2)
            || interleaved.len() > 96_000
        {
            self.counts.audio_dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if let Some(sender) = &self.audio_tx {
            if sender
                .try_send(AudioJob {
                    samples: interleaved.to_vec(),
                    pts,
                })
                .is_err()
            {
                self.counts.audio_dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn stats(&self) -> EncodeStats {
        EncodeStats {
            frames_in: self.counts.input.load(Ordering::Relaxed),
            frames_encoded: self.counts.encoded.load(Ordering::Relaxed),
            dropped: self.counts.dropped.load(Ordering::Relaxed),
            queue_len: self
                .counts
                .queue
                .load(Ordering::Relaxed)
                .min(QUEUE_SIZE as u64) as u32,
        }
    }

    /// Retains the first fatal error so the management thread can check at any time without waiting for another frame or stats interval.
    pub fn check_error(&self) -> Result<()> {
        self.counts.check_error()
    }

    /// Flush the encoder, write the final segment, and close.
    pub fn finish(mut self) -> Result<()> {
        self.close()?;
        self.check_error()
    }

    fn close(&mut self) -> Result<()> {
        self.video_tx.take();
        self.audio_tx.take();
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| {
                anyhow::anyhow!("encode_failed: Encoder thread terminated unexpectedly")
            })??;
        }
        let audio_dropped = self.counts.audio_dropped.swap(0, Ordering::Relaxed);
        if audio_dropped > 0 {
            eprintln!("Dropped {audio_dropped} audio input blocks; gaps were filled with silence based on timestamps");
        }
        Ok(())
    }
}
impl Drop for SegmentWriter {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("encode_failed: {error:#}");
        }
    }
}

fn frame_tick(slot: i64, fps: u32) -> i64 {
    ((slot as i128 * 10_000_000) / fps as i128) as i64
}
fn encode_frame(
    encoder: &Encoder,
    muxer: &mut mux::MuxWorker,
    source: &Frame,
    slot: i64,
    fps: u32,
    counts: &Counts,
) -> Result<()> {
    counts.check_error()?;
    let frame = source.duplicate()?;
    let pts = frame_tick(slot, fps);
    let duration = frame_tick(slot + 1, fps) - pts;
    // SAFETY: This function exclusively owns the copied frame metadata; the GPU buffer is read-only.
    unsafe {
        (*frame.0).pts = pts;
        (*frame.0).duration = duration;
        (*frame.0).pict_type = if slot % (fps as i64 * 2) == 0 {
            ffi::AV_PICTURE_TYPE_I
        } else {
            ffi::AV_PICTURE_TYPE_NONE
        };
    }
    let packets = encoder.send(Some(&frame))?;
    // SAFETY: This packet is exclusively owned and not yet handed to the muxer; some encoders do not set duration.
    unsafe {
        for p in &packets {
            if (*p.0).duration == 0 {
                (*p.0).duration = duration;
            }
        }
    }
    muxer.push(packets, true)?;
    counts.encoded.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

fn monitor_worker(counts: &Counts, run: impl FnOnce() -> Result<()>) -> Result<()> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Encoder thread terminated unexpectedly")));
    if let Err(error) = &result {
        counts.fail(error);
    }
    result
}

fn run_worker(
    encoder: Encoder,
    mut audio: Option<aac::Audio>,
    mut muxer: mux::MuxWorker,
    video_rx: Receiver<VideoJob>,
    audio_rx: Receiver<AudioJob>,
    counts: Arc<Counts>,
    fps: u32,
) -> Result<()> {
    let mut previous: Option<Arc<Surface>> = None;
    let mut next_slot = 0;
    let mut video_closed = false;
    let mut audio_closed = false;
    let mut anchor = None;
    let mut last_arrival = std::time::Instant::now();
    loop {
        counts.check_error()?;
        for _ in 0..8 {
            match audio_rx.try_recv() {
                Ok(job) => {
                    if let Some(audio) = &mut audio {
                        muxer.push(audio.push(&job.samples, job.pts)?, false)?;
                    }
                }
                Err(TryRecvError::Disconnected) => {
                    audio_closed = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        let mut job = match video_rx.recv_timeout(Duration::from_millis(5)) {
            Ok(job) => {
                counts.queue.fetch_sub(1, Ordering::Relaxed);
                last_arrival = std::time::Instant::now();
                if anchor.is_none() {
                    anchor = Some((last_arrival, job.slot));
                }
                Some(job)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                video_closed = true;
                None
            }
            Err(mpsc::RecvTimeoutError::Timeout) => None,
        };
        let closing = video_closed && audio_closed;
        counts.check_error()?;
        // WGC may stop sending frames for a static image; wait 200 ms before using the last frame to fill CFR, avoiding premature fills during normal capture jitter.
        if job.is_none() && last_arrival.elapsed() > Duration::from_millis(200) {
            if let (Some((started, slot)), Some(surface)) = (anchor, &previous) {
                let end = slot + (started.elapsed().as_secs_f64() * fps as f64) as i64
                    - if closing { 0 } else { i64::from(fps / 5) };
                if end > next_slot {
                    job = Some(VideoJob {
                        surface: surface.clone(),
                        slot: end - 1,
                    });
                }
            }
        }
        if let Some(job) = job {
            if job.slot >= next_slot {
                if let Some(last) = &previous {
                    while next_slot < job.slot {
                        encode_frame(&encoder, &mut muxer, &last.frame, next_slot, fps, &counts)?;
                        next_slot += 1;
                        advance_audio(&mut audio, &mut muxer, next_slot, fps)?;
                    }
                }
                encode_frame(
                    &encoder,
                    &mut muxer,
                    &job.surface.frame,
                    job.slot,
                    fps,
                    &counts,
                )?;
                next_slot = job.slot + 1;
                previous = Some(job.surface);
                advance_audio(&mut audio, &mut muxer, next_slot, fps)?;
            } else {
                counts.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        if closing {
            break;
        }
        if video_closed {
            thread::yield_now();
        }
    }
    let tail = encoder.send(None)?;
    // SAFETY: The flush packet is exclusively owned by this thread; the final frame also needs a duration to remain included when splitting segments.
    unsafe {
        for packet in &tail {
            if (*packet.0).duration == 0 {
                let slot =
                    (((*packet.0).pts as i128 * fps as i128 + 5_000_000) / 10_000_000) as i64;
                (*packet.0).duration = frame_tick(slot + 1, fps) - frame_tick(slot, fps);
            }
        }
    }
    muxer.push(tail, true)?;
    if let Some(audio) = &mut audio {
        muxer.push(audio.finish(frame_tick(next_slot, fps))?, false)?;
    }
    muxer.finish()
}

fn advance_audio(
    audio: &mut Option<aac::Audio>,
    muxer: &mut mux::MuxWorker,
    next_slot: i64,
    fps: u32,
) -> Result<()> {
    if let Some(audio) = audio {
        // When audio falls more than 200 ms behind, fill with silence; advance one frame at a time during long capture interruptions to maintain segment and memory limits.
        let safe = (frame_tick(next_slot, fps) as i128 * 48_000 / 10_000_000 - 9_600).max(0) as i64;
        muxer.push(audio.advance(safe)?, false)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
