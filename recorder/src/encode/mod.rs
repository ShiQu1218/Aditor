//! 硬體編碼＋fMP4 段落（任務 B1）。透過 `ffi`（預先產生的 ffmpeg 綁定）使用專案內建的
//! LGPL ffmpeg DLL：D3D11 hwframe → `*_nvenc`／`*_amf`／`*_qsv`；音訊 AAC；
//! 封裝為 `init.mp4` ＋ 每 2 秒一個 `seg_NNNNNN.m4s`（GOP 2 秒強制對齊，規格 §2.1）。
//!
//! 介面由骨架固定，實作者不得改動簽章。

mod aac;
pub mod ffi;
mod ffmpeg;
mod hardware;
mod mux;

use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender, TryRecvError, TrySendError},
        Arc, Mutex, OnceLock, TryLockError,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use anyhow::{bail, ensure, Context, Result};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

use crate::gpu::Gpu;
use crate::types::{Codec, EncodeAspect, EncodePreset};
pub(crate) use ffmpeg::check_version;
use ffmpeg::{Encoder, Frame};
use hardware::{Copier, Hardware};

const ENCODERS: [&str; 9] = [
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
    /// 輸出尺寸（偶數）。來源尺寸不同時在 GPU 縮放。
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Codec,
    /// `"auto"` 或明確編碼器名稱。
    pub encoder: String,
    pub bitrate_kbps: u32,
    pub preset: EncodePreset,
    pub aspect: EncodeAspect,
}

/// 一個段落寫完（已 flush＋fsync）後送出。
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
    /// 佇列滿，本格丟棄（計入 `dropped`）。
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
// SAFETY: 基礎 AVFrame 的欄位不再修改，worker 只複製參照；producer 在確認沒有其他參照時才重用 texture。
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

fn candidates(video: &VideoParams) -> Vec<&str> {
    if video.encoder != "auto" {
        return ENCODERS
            .iter()
            .copied()
            .filter(|name| *name == video.encoder && codec_of(name) == video.codec)
            .collect();
    }
    let mut names: Vec<_> = ENCODERS
        .iter()
        .copied()
        .filter(|name| codec_of(name) == video.codec)
        .collect();
    if video.codec == Codec::Hevc {
        names.extend(
            ENCODERS
                .iter()
                .copied()
                .filter(|name| codec_of(name) == Codec::H264),
        );
    }
    names
}
fn codec_of(name: &str) -> Codec {
    if name.starts_with("hevc_") {
        Codec::Hevc
    } else if name.starts_with("av1_") {
        Codec::Av1
    } else {
        Codec::H264
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
    let mut failure = String::new();
    for format in [ffi::AV_PIX_FMT_BGRA, ffi::AV_PIX_FMT_NV12] {
        let attempt = || -> Result<()> {
            let hardware = Hardware::new(gpu, &params, format)?;
            let encoder = hardware.encoder(name, &params)?;
            let frame = hardware.surface()?;
            // SAFETY: 影格在本執行緒獨佔，設定首次編碼的時間戳。
            unsafe {
                (*frame.0).pts = 0;
            }
            let packets = encoder.send(Some(&frame))?;
            let tail = encoder.send(None)?;
            ensure!(
                !packets.is_empty() || !tail.is_empty(),
                "試編碼沒有輸出封包"
            );
            Ok(())
        };
        match attempt() {
            Ok(()) => return Ok(format),
            Err(error) => failure = format!("{error:#}"),
        }
    }
    bail!("{name} 試編碼失敗：{failure}")
}

impl SegmentWriter {
    /// 依序嘗試開啟各硬體編碼器（小尺寸試編一格），回傳可用者名稱，例如 `["hevc_nvenc","h264_nvenc"]`。
    pub fn probe_encoders(gpu: &Gpu) -> Vec<String> {
        ENCODERS
            .iter()
            .filter(|name| probe(gpu, name).is_ok())
            .map(|name| (*name).to_owned())
            .collect()
    }

    /// 開啟編碼器與 muxer，寫出 `init.mp4`。`audio = true` 時建立 48 kHz 立體聲 AAC 軌。
    /// 沒有可用硬體編碼器時回傳錯誤（訊息含 `no_hw_encoder`）。
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
            "輸出尺寸必須是 2–16384 的偶數"
        );
        ensure!(
            (1..=144).contains(&video.fps) && (1..=1_000_000).contains(&video.bitrate_kbps),
            "FPS 或位元率超出支援範圍"
        );
        let mut selected = None;
        let mut failures = Vec::new();
        for name in candidates(&video) {
            let attempt = || -> Result<_> {
                let format = probe(gpu, name)?;
                let hardware = Hardware::new(gpu, &video, format)?;
                let encoder = hardware.encoder(name, &video)?;
                Ok((hardware, encoder))
            };
            match attempt() {
                Ok((hardware, encoder)) => {
                    selected = Some((name.to_owned(), hardware, encoder));
                    break;
                }
                Err(error) => failures.push(format!("{name}: {error:#}")),
            }
        }
        let Some((name, hardware, encoder)) = selected else {
            bail!(
                "no_hw_encoder: 沒有可用的硬體編碼器；{}",
                failures.join("；")
            );
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
        let worker_counts = counts.clone();
        let fps = video.fps;
        let worker = thread::Builder::new()
            .name("apexrec-encode".into())
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
            .context("建立編碼執行緒失敗")?;
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

    /// 實際使用的編碼器名稱。
    pub fn encoder_name(&self) -> &str {
        &self.name
    }

    /// 擷取執行緒呼叫：GPU 複製進內部 pool 後立即返回，不得阻塞。
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
                    self.counts.fail("GPU 表面池鎖已損毀");
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
                    // SAFETY: 基礎影格持續有效；AVBuffer 參照計數是原子讀取，避免重用編碼器尚持有的表面。
                    unsafe { ffi::av_buffer_get_ref_count((*surface.frame.0).buf[0]) == 1 }
                })?
                .clone();
            if let Err(error) = producer
                .copier
                .copy(texture, (src_w, src_h), &surface.frame)
            {
                self.counts.fail(format!("GPU 影格複製失敗：{error:#}"));
                return None;
            }
            self.counts.queue.fetch_add(1, Ordering::Relaxed);
            match self.video_tx.as_ref()?.try_send(VideoJob { surface, slot }) {
                Ok(()) => {}
                Err(error) => {
                    self.counts.queue.fetch_sub(1, Ordering::Relaxed);
                    if matches!(error, TrySendError::Disconnected(_)) {
                        self.counts.fail("編碼執行緒已結束");
                    }
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

    /// 音訊執行緒呼叫：48 kHz 立體聲交錯 f32；`pts` 為第一個樣本的 tick。
    pub fn push_audio(&self, interleaved: &[f32], pts: i64) {
        if self.counts.error.get().is_some() {
            return;
        }
        // 每塊最多一秒，限制異常呼叫的複製量；音訊缺口由下一個 QPC 時戳補靜音。
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

    /// 致命錯誤保留第一個原因，管理執行緒可隨時檢查，不必等下一格或統計週期。
    pub fn check_error(&self) -> Result<()> {
        self.counts.check_error()
    }

    /// flush 編碼器、寫出最後一段並關閉。
    pub fn finish(mut self) -> Result<()> {
        self.close()?;
        self.check_error()
    }

    fn close(&mut self) -> Result<()> {
        self.video_tx.take();
        self.audio_tx.take();
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| anyhow::anyhow!("encode_failed: 編碼執行緒異常結束"))??;
        }
        let audio_dropped = self.counts.audio_dropped.swap(0, Ordering::Relaxed);
        if audio_dropped > 0 {
            eprintln!("音訊輸入丟棄 {audio_dropped} 塊，缺口已依時間戳補靜音");
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
    muxer: &mut mux::Muxer,
    source: &Frame,
    slot: i64,
    fps: u32,
    counts: &Counts,
) -> Result<()> {
    counts.check_error()?;
    let frame = source.duplicate()?;
    let pts = frame_tick(slot, fps);
    let duration = frame_tick(slot + 1, fps) - pts;
    // SAFETY: 複製影格的 metadata 在此函式獨佔；GPU buffer 只讀取。
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
    // SAFETY: 封包是尚未移交 muxer 的獨佔輸出；部分編碼器沒有填 duration。
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
        .unwrap_or_else(|_| Err(anyhow::anyhow!("編碼執行緒異常結束")));
    if let Err(error) = &result {
        counts.fail(error);
    }
    result
}

fn run_worker(
    encoder: Encoder,
    mut audio: Option<aac::Audio>,
    mut muxer: mux::Muxer,
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
        // WGC 在靜止畫面可能完全停送；等待 200 ms 後才用最後一格補 CFR，避免一般擷取抖動造成搶先補格。
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
    // SAFETY: flush 回傳的封包由此執行緒獨佔；尾格同樣需要 duration 才不會在切段時被排除。
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
    muxer: &mut mux::Muxer,
    next_slot: i64,
    fps: u32,
) -> Result<()> {
    if let Some(audio) = audio {
        // 音訊落後超過 200 ms 時補靜音；長時間擷取中斷也逐格前進，維持分段及記憶體上限。
        let safe = (frame_tick(next_slot, fps) as i128 * 48_000 / 10_000_000 - 9_600).max(0) as i64;
        muxer.push(audio.advance(safe)?, false)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
