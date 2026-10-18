//! 錄影整合：回呼僅提交 GPU 影格／有界小圖佇列，管理執行緒負責 IPC、索引與收尾。

use crate::{
    audio::{self, AudioCapture, AudioSink},
    capture::{
        dda,
        small::{SmallFrameExtractor, SmallFrames},
        Capture, CaptureMethod, CaptureNotice, CaptureOptions, CapturedFrame, FrameConsumer,
    },
    clock::{self, TICKS_PER_SEC},
    encode::{EncodeStats, SegmentInfo, SegmentWriter, VideoParams},
    gpu::Gpu,
    index::{self, IndexWriter, SessionMeta},
    ipc::{Backend, BackendError, EventSink},
    protocol::{ErrorCode, Event, HelloInfo, StartArgs},
    shm::{self, ShmLayout, ShmWriter},
    types::{Codec, EncodeAspect, Rect, AUDIO_CHANNELS, SEGMENT_SECS, THUMB_H, THUMB_W},
};
use anyhow::{bail, ensure, Context, Result};
use std::{
    cell::{Cell, RefCell},
    fs,
    os::windows::ffi::OsStrExt,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
        Arc, OnceLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{FILETIME, SYSTEMTIME},
        Storage::FileSystem::GetDiskFreeSpaceExW,
        System::{
            Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST},
            Time::FileTimeToSystemTime,
        },
    },
};

const DISK_RESERVE: u64 = 1024 * 1024 * 1024;
const STATS_INTERVAL: Duration = Duration::from_secs(5);

// 保留骨架的 unit struct 建構介面；每個 IPC 控制執行緒只擁有一個錄影工作。
thread_local! {
    static RUNNING: RefCell<Option<Running>> = const { RefCell::new(None) };
    static CALLBACK_PRIORITY: Cell<bool> = const { Cell::new(false) };
}

#[derive(Default)]
pub struct Recorder;
struct Running {
    active: Arc<AtomicBool>,
    stop: Sender<()>,
    worker: JoinHandle<Result<(), BackendError>>,
}

impl Backend for Recorder {
    fn hello(&mut self) -> HelloInfo {
        HelloInfo {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            encoders: Gpu::create()
                .map(|gpu| SegmentWriter::probe_encoders(&gpu))
                .unwrap_or_default(),
            audio: audio::list_devices().unwrap_or_default(),
        }
    }
    fn start(&mut self, args: StartArgs, events: EventSink) -> Result<(), BackendError> {
        RUNNING.with_borrow_mut(|running| {
            if running
                .as_ref()
                .is_some_and(|r| r.active.load(Ordering::Acquire))
            {
                return Err((ErrorCode::Busy, "已有錄影工作執行中".into()));
            }
            if let Some(old) = running.take() {
                let _ = old.worker.join();
            }
            validate(&args).map_err(|e| failure(ErrorCode::BadRequest, e))?;
            let (stop, stopped) = mpsc::channel();
            let (ready, initialized) = mpsc::sync_channel(1);
            let active = Arc::new(AtomicBool::new(true));
            let worker_active = active.clone();
            let worker = thread::Builder::new()
                .name("apexrec-session".into())
                .spawn(move || {
                    let mut session = match Session::open(&args, events) {
                        Ok(session) => session,
                        Err(error) => {
                            let _ = ready.send(Err(error.clone()));
                            return Err(error);
                        }
                    };
                    let _ = ready.send(Ok(()));
                    let result = session.run(&args.session_dir, &stopped);
                    let finish = session.finish();
                    let result = result.and(finish);
                    let reason = match &result {
                        Ok(()) => "requested".into(),
                        Err((code, message)) => {
                            session.events.emit(&Event::Error {
                                code: *code,
                                message: message.clone(),
                            });
                            format!("{code:?}").to_lowercase()
                        }
                    };
                    worker_active.store(false, Ordering::Release);
                    session.events.emit(&Event::Stopped { reason });
                    result
                })
                .map_err(|e| failure(ErrorCode::Internal, e))?;
            match initialized.recv() {
                Ok(Ok(())) => {
                    *running = Some(Running {
                        active,
                        stop,
                        worker,
                    });
                    Ok(())
                }
                result => {
                    let _ = worker.join();
                    result.unwrap_or_else(|_| {
                        Err((ErrorCode::Internal, "錄影初始化執行緒中斷".into()))
                    })
                }
            }
        })
    }
    fn stop(&mut self) -> Result<(), BackendError> {
        RUNNING.with_borrow_mut(|running| {
            let Some(running) = running.take() else {
                return Ok(());
            };
            let _ = running.stop.send(());
            running
                .worker
                .join()
                .map_err(|_| (ErrorCode::Internal, "錄影管理執行緒異常結束".into()))?
        })
    }
}
impl Drop for Recorder {
    fn drop(&mut self) {
        if let Err((_, message)) = self.stop() {
            eprintln!("錄影收尾失敗：{message}");
        }
    }
}

#[derive(Default)]
struct Counts {
    input: AtomicU64,
    small_attempts: AtomicU64,
    small_sent: AtomicU64,
    last_audio: AtomicI64,
}
struct Consumer {
    pipeline: Arc<OnceLock<Option<Arc<SegmentWriter>>>>,
    extractor: SmallFrameExtractor,
    small: SyncSender<SmallFrames>,
    first: Option<SyncSender<i64>>,
    origin: Option<i64>,
    small_bucket: Option<i64>,
    counts: Arc<Counts>,
}
impl FrameConsumer for Consumer {
    fn on_frame(&mut self, frame: &CapturedFrame<'_>) {
        CALLBACK_PRIORITY.with(|set| {
            if !set.replace(true) {
                // SAFETY: 僅調整目前 WGC 回呼執行緒；below-normal 基準 6 加 2 回到一般基準 8。
                unsafe {
                    let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
                }
            }
        });
        let Some(writer) = self.pipeline.get() else {
            return;
        };
        let origin = *self.origin.get_or_insert(frame.pts);
        let pts = frame.pts - origin;
        self.counts.input.fetch_add(1, Ordering::Relaxed);
        if let Some(writer) = writer {
            let _ = writer.push_video(frame.texture, frame.width, frame.height, pts);
        }
        let bucket = (pts as i128 * 4 / TICKS_PER_SEC as i128) as i64;
        if self.small_bucket != Some(bucket) {
            self.small_bucket = Some(bucket);
            self.counts.small_attempts.fetch_add(1, Ordering::Relaxed);
        }
        if let Some(small) = self
            .extractor
            .on_frame(frame.texture, frame.width, frame.height, pts)
        {
            if self.small.try_send(small).is_ok() {
                self.counts.small_sent.fetch_add(1, Ordering::Relaxed);
            }
        }
        if let Some(first) = self.first.take() {
            let _ = first.try_send(origin);
        }
    }
}
struct Sound {
    writer: Arc<SegmentWriter>,
    counts: Arc<Counts>,
}
impl AudioSink for Sound {
    fn on_audio(&mut self, interleaved: &[f32], pts: i64) {
        debug_assert!(interleaved.len().is_multiple_of(AUDIO_CHANNELS as usize));
        self.writer.push_audio(interleaved, pts);
        self.counts
            .last_audio
            .store(clock::now_ticks(), Ordering::Relaxed);
    }
}
struct Session {
    announced: bool,
    dir: std::path::PathBuf,
    published: usize,
    capture: Option<Capture>,
    audio: Option<AudioCapture>,
    writer: Option<Arc<SegmentWriter>>,
    index: Option<IndexWriter>,
    shm: ShmWriter,
    segments: Receiver<SegmentInfo>,
    notices: Receiver<CaptureNotice>,
    small: Receiver<SmallFrames>,
    counts: Arc<Counts>,
    events: EventSink,
    last_stats: Instant,
    previous: EncodeStats,
}
/// 目錄裡是否已有 apexrec 寫出的檔案（init、索引、session.json 或段落）。
fn has_recorder_output(dir: &Path) -> Result<bool> {
    for entry in fs::read_dir(dir).context("讀取錄影目錄失敗")? {
        let name = entry.context("讀取錄影目錄失敗")?.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), "init.mp4" | "index.jsonl" | "session.json")
            || (name.starts_with("seg_") && name.ends_with(".m4s"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Session {
    fn open(args: &StartArgs, events: EventSink) -> Result<Self, BackendError> {
        let dir = Path::new(&args.session_dir);
        let prepare = || -> Result<()> {
            fs::create_dir_all(dir).context("建立錄影目錄失敗")?;
            // 主程序會先寫自己的 recording.json；只拒絕已有本程式輸出的目錄，避免覆寫既有錄影。
            ensure!(
                !has_recorder_output(dir)?,
                "錄影目錄已有錄影輸出，避免覆寫既有工作"
            );
            check_disk(dir)
        };
        prepare().map_err(|e| failure(ErrorCode::Internal, e))?;
        let gpu = match args.capture {
            CaptureMethod::Wgc => Gpu::create(),
            CaptureMethod::Dda => dda::gpu_for_pid(args.pid),
        }
        .map_err(|e| failure(ErrorCode::CaptureFailed, e))?;
        let extractor = SmallFrameExtractor::new(&gpu, args.frames)
            .map_err(|e| failure(ErrorCode::BadRequest, e))?;
        let name = shm::shm_name(&args.session_id);
        let shm = ShmWriter::create(
            &name,
            ShmLayout {
                banner: extractor.banner_size(),
                spec: extractor.spec_size(),
                thumb: (THUMB_W, THUMB_H),
            },
        )
        .map_err(|e| failure(ErrorCode::Internal, e))?;
        let (notice_tx, notices) = mpsc::channel();
        let (segment_tx, segments) = mpsc::channel();
        let (small_tx, small) = mpsc::sync_channel(8);
        let (first_tx, first) = mpsc::sync_channel(1);
        let pipeline = Arc::new(OnceLock::new());
        let counts = Arc::new(Counts::default());
        let fps = args.encode.as_ref().map_or(60, |cfg| cfg.fps);
        let capture = Capture::start_with(
            args.capture,
            &gpu,
            CaptureOptions {
                pid: args.pid,
                max_fps: fps,
                origin_ticks: 0,
            },
            Box::new(Consumer {
                pipeline: pipeline.clone(),
                extractor,
                small: small_tx,
                first: Some(first_tx),
                origin: None,
                small_bucket: None,
                counts: counts.clone(),
            }),
            notice_tx,
        )
        .map_err(|e| failure(ErrorCode::CaptureFailed, e))?;
        let mut session = Self {
            announced: false,
            dir: dir.to_owned(),
            published: 0,
            capture: Some(capture),
            audio: None,
            writer: None,
            index: None,
            shm,
            segments,
            notices,
            small,
            counts,
            events,
            last_stats: Instant::now(),
            previous: EncodeStats::default(),
        };
        let (source_w, source_h) = match session.notices.recv_timeout(Duration::from_secs(5)) {
            Ok(CaptureNotice::WindowFound { width, height, .. }) => (width, height),
            _ => return Err((ErrorCode::CaptureFailed, "未取得擷取視窗尺寸".into())),
        };
        let (width, height) = if let Some(cfg) = &args.encode {
            output_size(source_w, source_h, cfg.height, cfg.aspect)
                .map_err(|e| failure(ErrorCode::BadRequest, e))?
        } else {
            (source_w, source_h)
        };
        if let Some(cfg) = &args.encode {
            session.index =
                Some(IndexWriter::create(dir).map_err(|e| failure(ErrorCode::Internal, e))?);
            session.writer = Some(Arc::new(
                SegmentWriter::open(
                    &gpu,
                    dir,
                    VideoParams {
                        width,
                        height,
                        fps,
                        codec: cfg.codec,
                        encoder: cfg.encoder.clone(),
                        bitrate_kbps: cfg.bitrate_kbps,
                        preset: cfg.preset,
                        aspect: cfg.aspect,
                    },
                    args.audio.is_some(),
                    segment_tx,
                )
                .map_err(|e| failure(ErrorCode::EncodeFailed, e))?,
            ));
        }
        let encoder = session.writer.as_ref().map(|w| w.encoder_name().to_owned());
        let _ = pipeline.set(session.writer.clone());
        drop(pipeline);
        let origin = first.recv_timeout(Duration::from_secs(5)).map_err(|e| {
            failure(
                ErrorCode::CaptureFailed,
                anyhow::anyhow!("等待第一格逾時：{e}"),
            )
        })?;
        if let (Some(cfg), Some(writer)) = (&args.audio, &session.writer) {
            session
                .counts
                .last_audio
                .store(clock::now_ticks(), Ordering::Relaxed);
            session.audio = Some(
                AudioCapture::start_for_pid(
                    cfg,
                    args.pid,
                    origin,
                    Box::new(Sound {
                        writer: writer.clone(),
                        counts: session.counts.clone(),
                    }),
                )
                .map_err(|e| failure(ErrorCode::AudioFailed, e))?,
            );
            if let Some(message) = session.audio.as_mut().and_then(AudioCapture::take_warning) {
                session.events.emit(&Event::Warning {
                    code: "game_audio_unavailable".into(),
                    message,
                });
            }
        }
        let codec = encoder.as_ref().map_or(Codec::Hevc, |name| {
            if name.starts_with("h264_") {
                Codec::H264
            } else if name.starts_with("av1_") {
                Codec::Av1
            } else {
                Codec::Hevc
            }
        });
        index::write_session_json(
            dir,
            &SessionMeta {
                session_id: args.session_id.clone(),
                started_at: timestamp().map_err(|e| failure(ErrorCode::Internal, e))?,
                encoder: encoder.clone().unwrap_or_default(),
                width,
                height,
                fps,
                codec,
                audio: session.audio.is_some(),
                apexrec_version: env!("CARGO_PKG_VERSION").into(),
            },
        )
        .map_err(|e| failure(ErrorCode::Internal, e))?;
        session.last_stats = Instant::now();
        session.announced = true;
        session.events.emit(&Event::Started {
            encoder,
            width,
            height,
            fps,
            shm: name,
        });
        Ok(session)
    }
    fn run(&mut self, dir: &str, stopped: &Receiver<()>) -> Result<(), BackendError> {
        let mut disk_checked = Instant::now();
        loop {
            self.drain()?;
            if self.last_stats.elapsed() >= STATS_INTERVAL {
                self.stats()?;
                if self.audio.is_some()
                    && clock::ticks_to_secs(
                        clock::now_ticks() - self.counts.last_audio.load(Ordering::Relaxed),
                    ) > 5.0
                {
                    return Err((ErrorCode::AudioFailed, "音訊擷取已超過五秒沒有輸出".into()));
                }
            }
            if disk_checked.elapsed() >= Duration::from_secs(30) {
                check_disk(Path::new(dir)).map_err(|e| failure(ErrorCode::Internal, e))?;
                disk_checked = Instant::now();
            }
            match stopped.recv_timeout(Duration::from_millis(20)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    fn drain(&mut self) -> Result<(), BackendError> {
        for segment in self.segments.try_iter() {
            if let Some(index) = &mut self.index {
                index
                    .append(&segment, SystemTime::now())
                    .map_err(|e| failure(ErrorCode::Internal, e))?;
            }
            if self.announced {
                self.events.emit(&Event::Segment {
                    seq: segment.seq,
                    pts: segment.pts_secs,
                    dur: segment.dur_secs,
                    bytes: segment.bytes,
                });
            }
            self.published += 1;
        }
        for small in self.small.try_iter() {
            self.shm
                .write(
                    small.pts,
                    &small.banner,
                    &small.spec,
                    small.thumb.as_deref(),
                )
                .map_err(|e| failure(ErrorCode::Internal, e))?;
        }
        loop {
            match self.notices.try_recv() {
                Ok(_) if !self.announced => {}
                Ok(CaptureNotice::WindowLost) => self.events.emit(&Event::WindowLost),
                Ok(CaptureNotice::WindowFound {
                    width,
                    height,
                    monitor,
                }) => self.events.emit(&Event::WindowFound {
                    width,
                    height,
                    monitor,
                }),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) if self.capture.is_some() => {
                    return Err((ErrorCode::CaptureFailed, "擷取管理執行緒已結束".into()))
                }
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
        Ok(())
    }
    fn stats(&mut self) -> Result<(), BackendError> {
        if !self.announced {
            return Ok(());
        }
        let stats = self.writer.as_ref().map_or_else(
            || EncodeStats {
                frames_in: self.counts.input.load(Ordering::Relaxed),
                ..Default::default()
            },
            |w| w.stats(),
        );
        let elapsed = self.last_stats.elapsed().as_secs_f64().max(0.001);
        let stalled = self.writer.is_some()
            && elapsed >= 5.0
            && stats.frames_in > self.previous.frames_in
            && stats.frames_encoded == self.previous.frames_encoded;
        self.events.emit(&Event::Stats {
            fps_in: stats.frames_in.saturating_sub(self.previous.frames_in) as f64 / elapsed,
            fps_enc: stats
                .frames_encoded
                .saturating_sub(self.previous.frames_encoded) as f64
                / elapsed,
            dropped: stats.dropped,
            small_dropped: self
                .counts
                .small_attempts
                .load(Ordering::Relaxed)
                .saturating_sub(self.counts.small_sent.load(Ordering::Relaxed) + 1),
            queue: stats.queue_len,
        });
        self.previous = stats;
        self.last_stats = Instant::now();
        if stalled {
            return Err((
                ErrorCode::EncodeFailed,
                "編碼器已超過五秒沒有處理影格".into(),
            ));
        }
        Ok(())
    }
    fn finish(&mut self) -> Result<(), BackendError> {
        if let Some(capture) = self.capture.take() {
            capture.stop();
        }
        if let Some(audio) = self.audio.take() {
            audio.stop();
        }
        let stats = self.stats();
        let finish = if let Some(writer) = self.writer.take() {
            Arc::try_unwrap(writer)
                .map_err(|_| (ErrorCode::Internal, "停止後仍有編碼器參照".into()))?
                .finish()
                .map_err(|e| failure(ErrorCode::EncodeFailed, e))
        } else {
            Ok(())
        };
        let drain = self.drain();
        stats.and(finish).and(drain)?;
        if self.index.is_some() {
            let entries = index::read_index(&self.dir.join("index.jsonl"))
                .map_err(|e| failure(ErrorCode::Internal, e))?;
            if entries.len() != self.published
                || entries
                    .iter()
                    .any(|entry| entry.dur > f64::from(SEGMENT_SECS) + 0.1)
            {
                return Err((ErrorCode::Internal, "段落索引與已公布事件不一致".into()));
            }
        }
        Ok(())
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if self.capture.is_some() || self.audio.is_some() || self.writer.is_some() {
            let _ = self.finish();
        }
    }
}
fn failure(default: ErrorCode, error: impl std::fmt::Display) -> BackendError {
    let message = format!("{error:#}");
    let code = if message.contains("no_hw_encoder:") {
        ErrorCode::NoHwEncoder
    } else if message.contains("window_not_found:") {
        ErrorCode::WindowNotFound
    } else if message.contains("disk_full:") {
        ErrorCode::DiskFull
    } else {
        default
    };
    (code, message)
}
fn validate(args: &StartArgs) -> Result<()> {
    ensure!(args.pid != 0, "PID 必須大於零");
    ensure!(
        !args.session_dir.is_empty() && !args.session_dir.contains('\0'),
        "錄影目錄不可為空或含 NUL"
    );
    ensure!(
        !args.session_id.is_empty()
            && args.session_id.len() <= 80
            && args
                .session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "工作識別碼只接受 1–80 個英數字、連字號與底線"
    );
    ensure!(args.frames.base == [1920, 1080], "小圖基準必須是 1920×1080");
    for roi in [args.frames.banner, args.frames.spec] {
        let rect = Rect::from_array(roi);
        ensure!(
            rect == rect.scaled((1920, 1080), (1920, 1080)),
            "小圖 ROI 超出基準畫面"
        );
    }
    if let Some(cfg) = &args.encode {
        ensure!(
            (1..=144).contains(&cfg.fps)
                && (1..=1_000_000).contains(&cfg.bitrate_kbps)
                && (cfg.height == 0
                    || (2..=16_384).contains(&cfg.height) && cfg.height.is_multiple_of(2)),
            "FPS、輸出高度或位元率超出範圍"
        );
    }
    Ok(())
}
fn output_size(
    width: u32,
    height: u32,
    requested: u32,
    aspect: EncodeAspect,
) -> Result<(u32, u32)> {
    ensure!(width >= 2 && height >= 2, "擷取尺寸太小");
    let h = if requested == 0 {
        height & !1
    } else {
        requested
    };
    let w = if aspect == EncodeAspect::Native {
        ((u64::from(width) * u64::from(h) / u64::from(height)) & !1) as u32
    } else {
        // 四捨五入到最接近的偶數。
        ((u64::from(h) * 16 + 9) / 18 * 2) as u32
    };
    ensure!(
        (2..=16_384).contains(&w) && (2..=16_384).contains(&h),
        "輸出尺寸超出硬體編碼範圍"
    );
    Ok((w, h))
}
fn check_disk(dir: &Path) -> Result<()> {
    let path: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    // SAFETY: 路徑以 NUL 結尾，輸出指向有效 u64；只查詢目前工作可用空間。
    unsafe { GetDiskFreeSpaceExW(PCWSTR(path.as_ptr()), Some(&mut available), None, None) }
        .context("查詢磁碟空間失敗")?;
    check_available(available)
}
fn check_available(available: u64) -> Result<()> {
    if available < DISK_RESERVE {
        bail!("disk_full: 可用空間不足 1 GiB");
    }
    Ok(())
}
fn timestamp() -> Result<String> {
    let ticks =
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos() / 100 + 116_444_736_000_000_000;
    let filetime = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    let mut utc = SYSTEMTIME::default();
    // SAFETY: FILETIME 為目前 UTC 時間；utc 為有效輸出結構。
    unsafe { FileTimeToSystemTime(&filetime, &mut utc) }.context("轉換錄影開始時間失敗")?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        utc.wYear, utc.wMonth, utc.wDay, utc.wHour, utc.wMinute, utc.wSecond, utc.wMilliseconds
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_metadata_is_allowed_but_recorder_output_is_not() {
        let dir = std::env::temp_dir().join(format!("apexrec-out-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(!has_recorder_output(&dir).unwrap());
        fs::write(dir.join("recording.json"), "{}").unwrap();
        assert!(!has_recorder_output(&dir).unwrap());
        fs::write(dir.join("seg_000001.m4s"), "").unwrap();
        assert!(has_recorder_output(&dir).unwrap());
        fs::remove_file(dir.join("seg_000001.m4s")).unwrap();
        fs::write(dir.join("index.jsonl"), "").unwrap();
        assert!(has_recorder_output(&dir).unwrap());
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn output_dimensions_are_even_and_preserve_aspect_ratio() {
        assert_eq!(
            output_size(2560, 1440, 1080, EncodeAspect::Native).unwrap(),
            (1920, 1080)
        );
        assert_eq!(
            output_size(1919, 1079, 0, EncodeAspect::Native).unwrap(),
            (1916, 1078)
        );
        assert!(output_size(0, 1080, 0, EncodeAspect::Native).is_err());
        for aspect in [EncodeAspect::Fit, EncodeAspect::Stretch] {
            assert_eq!(output_size(2560, 1080, 1080, aspect).unwrap(), (1920, 1080));
            assert_eq!(output_size(1440, 1080, 0, aspect).unwrap(), (1920, 1080));
        }
    }
    #[test]
    fn error_codes_preserve_module_failures() {
        assert_eq!(
            failure(ErrorCode::CaptureFailed, "window_not_found: 測試").0,
            ErrorCode::WindowNotFound
        );
        assert_eq!(
            failure(ErrorCode::EncodeFailed, "no_hw_encoder: 測試").0,
            ErrorCode::NoHwEncoder
        );
        assert_eq!(
            failure(ErrorCode::Internal, "disk_full: 測試").0,
            ErrorCode::DiskFull
        );
    }
    #[test]
    fn disk_reserve_stops_below_one_gib_and_accepts_the_boundary() {
        assert!(check_available(DISK_RESERVE).is_ok());
        assert!(check_available(DISK_RESERVE - 1).is_err());
    }
}
