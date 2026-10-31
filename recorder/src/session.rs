//! Recording integration: callbacks only submit GPU frames/bounded small-image queues; the management thread handles IPC, indexing, and finalization.

use crate::{
    audio::{self, AudioCapture, AudioSink},
    capture::{
        dda, hook,
        small::{SmallFrameExtractor, SmallFrames},
        Capture, CaptureMethod, CaptureNotice, CaptureOptions, CapturedFrame, FrameConsumer,
    },
    clock::{self, TICKS_PER_SEC},
    encode::{
        candidate_names, codec_of, probe_diagnostic, EncodeStats, SegmentInfo, SegmentWriter,
        VideoParams, ENCODERS,
    },
    gpu::{auto_order, AdapterDesc, Gpu, Vendor},
    index::{self, IndexWriter, SessionMeta},
    ipc::{Backend, BackendError, EventSink},
    protocol::{ErrorCode, Event, GpuInfo, HelloInfo, StartArgs},
    shm::{self, ShmLayout, ShmWriter},
    types::{Codec, EncodeAspect, EncodeConfig, Rect, AUDIO_CHANNELS, SEGMENT_SECS, THUMB_H, THUMB_W},
};
use anyhow::{bail, ensure, Context, Result};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    fs,
    os::windows::ffi::OsStrExt,
    path::{Component, Path, Prefix},
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
const AUTO_GPU: &str = "auto";

// Preserve the scaffold's unit struct constructor; each IPC control thread owns only one recording job.
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

impl Running {
    fn stop(self) -> Result<(), BackendError> {
        let was_active = self.active.load(Ordering::Acquire);
        let _ = self.stop.send(());
        let result = self
            .worker
            .join()
            .map_err(|_| (ErrorCode::Internal, "Recording management thread exited unexpectedly".into()))
            .and_then(|result| result);
        // Errors from automatic stops have already been emitted; subsequent stop calls only wait for resource release.
        if was_active {
            result
        } else {
            Ok(())
        }
    }
}

struct WorkerGuard {
    active: Arc<AtomicBool>,
    events: EventSink,
    announced: bool,
    failure: Option<ErrorCode>,
}

impl WorkerGuard {
    fn report_error(&mut self, error: &BackendError) {
        if self.failure.is_none() {
            self.failure = Some(error.0);
            self.events.emit(&Event::Error {
                code: error.0,
                message: error.1.clone(),
            });
        }
    }

    fn complete(&mut self, result: &Result<(), BackendError>) {
        if let Err(error) = result {
            self.report_error(error);
        }
        let reason = self.failure.map_or("requested", |code| code.as_str());
        self.active.store(false, Ordering::Release);
        self.announced = false;
        self.events.emit(&Event::Stopped {
            reason: reason.into(),
        });
    }
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        if self.announced {
            self.complete(&Err((ErrorCode::Internal, "Recording management thread exited unexpectedly".into())));
        } else {
            self.active.store(false, Ordering::Release);
        }
    }
}

impl Backend for Recorder {
    fn hello(&mut self) -> HelloInfo {
        probe_diagnostic("gpu_enumerate", "none");
        let (gpus, encoders) = match Gpu::enumerate() {
            Ok(adapters) => {
                let gpus: Vec<GpuInfo> = adapters
                    .iter()
                    .filter(|adapter| !adapter.desc.software)
                    .filter_map(|adapter| {
                        probe_diagnostic("gpu_create", "none");
                        let gpu = adapter.create_gpu().ok()?;
                        let vendor = Vendor::from_vendor_id(adapter.desc.vendor_id);
                        Some(GpuInfo {
                            id: adapter.id.clone(),
                            name: adapter.desc.name.clone(),
                            vendor: vendor.as_str().into(),
                            encoders: SegmentWriter::probe_encoders_for_family(
                                &gpu,
                                vendor.encoder_family(),
                            ),
                        })
                    })
                    .collect();
                let encoders = encoder_union(&gpus);
                (gpus, encoders)
            }
            // Older behavior: the default adapter with a full probe, so all adapters that fail enumeration still work.
            Err(_) => (
                Vec::new(),
                Gpu::create()
                    .map(|gpu| SegmentWriter::probe_encoders(&gpu))
                    .unwrap_or_default(),
            ),
        };
        probe_diagnostic("audio_devices", "none");
        let audio = audio::list_devices().unwrap_or_default();
        probe_diagnostic("ready", "none");
        HelloInfo {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            encoders,
            gpus,
            audio,
        }
    }
    fn start(&mut self, args: StartArgs, events: EventSink) -> Result<(), BackendError> {
        RUNNING.with_borrow_mut(|running| {
            if running
                .as_ref()
                .is_some_and(|r| r.active.load(Ordering::Acquire))
            {
                return Err((ErrorCode::Busy, "A recording is already running".into()));
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
                .name("aditorrec-session".into())
                .spawn(move || {
                    let mut guard = WorkerGuard {
                        active: worker_active,
                        events: events.clone(),
                        announced: false,
                        failure: None,
                    };
                    let mut session = match Session::open(&args, events) {
                        Ok(session) => session,
                        Err(error) => {
                            let _ = ready.send(Err(error.clone()));
                            return Err(error);
                        }
                    };
                    guard.announced = true;
                    let _ = ready.send(Ok(()));
                    let result = session.run(&args.session_dir, &stopped);
                    // Cleanup can wait on a stuck driver or disk; report the original failure first.
                    if let Err(error) = &result {
                        guard.report_error(error);
                    }
                    let finish = session.finish();
                    let result = result.and(finish);
                    guard.complete(&result);
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
                        Err((ErrorCode::Internal, "Recording initialization thread interrupted".into()))
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
            running.stop()
        })
    }
    fn is_running(&self) -> bool {
        RUNNING.with_borrow(|running| {
            running
                .as_ref()
                .is_some_and(|running| running.active.load(Ordering::Acquire))
        })
    }
}
impl Drop for Recorder {
    fn drop(&mut self) {
        if let Err((_, message)) = self.stop() {
            eprintln!("Recording shutdown failed: {message}");
        }
    }
}

/// Whether an adapter must be used explicitly or auto-selected in vendor order.
#[derive(Debug, PartialEq, Eq)]
enum GpuChoice {
    Explicit(usize),
    Auto(Vec<usize>),
}

/// Resolve an explicit adapter ID first, otherwise return hardware adapters in automatic order.
fn choose_adapters(preference: &str, ids: &[String], descs: &[AdapterDesc]) -> GpuChoice {
    if preference != AUTO_GPU {
        if let Some(index) = ids.iter().position(|id| id == preference) {
            return GpuChoice::Explicit(index);
        }
    }
    GpuChoice::Auto(auto_order(descs))
}

/// Encoder names whose suffix matches the adapter's vendor family; unknown vendors cannot encode.
fn names_for_adapter(names: &[&'static str], family: Option<&str>) -> Vec<&'static str> {
    let Some(family) = family else {
        return Vec::new();
    };
    let suffix = format!("_{family}");
    names
        .iter()
        .copied()
        .filter(|name| name.ends_with(&suffix))
        .collect()
}

/// Union of per-GPU encoders in the automatic selection order.
fn encoder_union(gpus: &[GpuInfo]) -> Vec<String> {
    ENCODERS
        .iter()
        .filter(|name| {
            gpus.iter()
                .any(|gpu| gpu.encoders.iter().any(|encoder| encoder == *name))
        })
        .map(|name| (*name).to_owned())
        .collect()
}

/// Choose the D3D11 device for window capture: an explicit adapter, or the first adapter with a working encoder for the codec.
fn resolve_gpu(preference: &str, codec: Codec, encoder: &str) -> Result<Gpu> {
    let adapters = match Gpu::enumerate() {
        Ok(adapters) => adapters,
        // Fall back to the default adapter so the existing no_hw_encoder error path stays unchanged.
        Err(_) => return Gpu::create(),
    };
    let ids: Vec<String> = adapters.iter().map(|adapter| adapter.id.clone()).collect();
    let descs: Vec<AdapterDesc> = adapters
        .iter()
        .map(|adapter| adapter.desc.clone())
        .collect();
    let names = candidate_names(codec, encoder);
    match choose_adapters(preference, &ids, &descs) {
        GpuChoice::Explicit(index) => adapters[index].create_gpu(),
        GpuChoice::Auto(order) => {
            if preference != AUTO_GPU {
                eprintln!("Recording GPU {preference} was not found; selecting automatically");
            }
            for index in order {
                let family =
                    Vendor::from_vendor_id(adapters[index].desc.vendor_id).encoder_family();
                let names = names_for_adapter(&names, family);
                if names.is_empty() {
                    continue;
                }
                let Ok(gpu) = adapters[index].create_gpu() else {
                    continue;
                };
                if SegmentWriter::supports_any(&gpu, &names) {
                    return Ok(gpu);
                }
            }
            // No probed adapter has a working encoder; let the encoder report the detailed no_hw_encoder error.
            Gpu::create()
        }
    }
}

/// Choose a working hardware encoder for the same codec as `requested`, excluding the requested name.
/// The DDA adapter may differ from the adapter the global encoder list was probed on, so only names
/// proven by a trial encode are returned; callers must never cross codec boundaries here.
fn same_codec_fallback<'a>(
    codec: Codec,
    requested: &str,
    available: &[&'a str],
) -> Option<&'a str> {
    available
        .iter()
        .copied()
        .find(|name| *name != requested && codec_of(name) == codec)
}

/// DDA must encode on the adapter driving the game monitor. If the user selected an encoder that is
/// not available there, warn and fall back to a working hardware encoder with the same codec.
/// WGC keeps its explicit-encoder semantics and never goes through this path.
fn dda_encoder(gpu: &Gpu, cfg: &EncodeConfig, events: &EventSink) -> String {
    if cfg.encoder == "auto" {
        return cfg.encoder.clone();
    }
    let available = SegmentWriter::probe_encoders_for_family(gpu, gpu.vendor().encoder_family());
    if available.iter().any(|name| name == &cfg.encoder) {
        return cfg.encoder.clone();
    }
    let names: Vec<&str> = available.iter().map(String::as_str).collect();
    let Some(fallback) = same_codec_fallback(cfg.codec, &cfg.encoder, &names) else {
        // No same-codec fallback exists; let SegmentWriter::open report the detailed no_hw_encoder error.
        return cfg.encoder.clone();
    };
    events.emit(&Event::Warning {
        code: "encoder_fallback".into(),
        message: format!(
            "The selected encoder {} is not available on the GPU used for desktop capture; using {} instead",
            cfg.encoder, fallback
        ),
    });
    fallback.to_owned()
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
                // SAFETY: Adjust only the current WGC callback thread; below-normal base 6 plus 2 restores normal base 8.
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
            // The writer retains fatal errors for the management thread to check each iteration; ordinary queue overflow may still drop frames.
            writer.push_video(frame.texture, frame.width, frame.height, pts);
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
    capture_origin: i64,
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
    audio_stall_warned: bool,
    /// DDA records the real desktop while the game is hidden; detection still needs black frames to split matches there.
    /// Visibility as of the oldest queued change; small frames read back one sample late, so they are judged by their own pts.
    game_hidden: bool,
    visibility_changes: VecDeque<(i64, bool)>,
}
/// Whether the game was hidden when the frame at `pts` was captured; applies and drops the changes that frame has passed.
fn hidden_at(hidden: &mut bool, changes: &mut VecDeque<(i64, bool)>, pts: i64) -> bool {
    while let Some(&(at, next)) = changes.front() {
        if at > pts {
            break;
        }
        *hidden = next;
        changes.pop_front();
    }
    *hidden
}
fn blank_small_frames(small: &mut SmallFrames) {
    for buf in [&mut small.banner, &mut small.spec]
        .into_iter()
        .chain(small.killfeed.as_mut())
        .chain(small.thumb.as_mut())
    {
        buf.fill(0);
    }
}
/// Whether the directory contains aditorrec output (init, index, session.json, or segments).
fn has_recorder_output(dir: &Path) -> Result<bool> {
    for entry in fs::read_dir(dir).context("Failed to read recording directory")? {
        let name = entry.context("Failed to read recording directory")?.file_name();
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
            fs::create_dir_all(dir).context("Failed to create recording directory")?;
            // The main process writes recording.json first; reject only directories containing our output to avoid overwriting recordings.
            ensure!(
                !has_recorder_output(dir)?,
                "Recording directory already contains output; refusing to overwrite an existing job"
            );
            check_disk(dir)
        };
        prepare().map_err(|e| failure(ErrorCode::Internal, e))?;
        let fps = args.encode.as_ref().map_or(60, |cfg| cfg.fps);
        let (gpu, prepared_hook) = match args.capture {
            CaptureMethod::Wgc => (
                match &args.encode {
                    // Window capture may run on any adapter; screen capture must use the adapter driving the game monitor.
                    Some(cfg) => resolve_gpu(&cfg.gpu, cfg.codec, &cfg.encoder),
                    None => Gpu::create(),
                }
                .map_err(|e| failure(ErrorCode::CaptureFailed, e))?,
                None,
            ),
            CaptureMethod::Dda => (
                dda::gpu_for_pid(args.pid).map_err(|e| failure(ErrorCode::CaptureFailed, e))?,
                None,
            ),
            CaptureMethod::Hook => {
                let Some(hook_dir) = args.hook_dir.as_deref().filter(|s| !s.is_empty()) else {
                    return Err((
                        ErrorCode::HookUnavailable,
                        "hook_unavailable: Missing hook_dir".into(),
                    ));
                };
                let (prepared, gpu) =
                    hook::prepare(args.pid, Path::new(hook_dir), fps, hook::PREPARE_BUDGET)
                        .map_err(|e| failure(ErrorCode::CaptureFailed, e))?;
                (gpu, Some(prepared))
            }
        };
        let extractor = SmallFrameExtractor::new(&gpu, args.frames)
            .map_err(|e| failure(ErrorCode::BadRequest, e))?;
        let name = shm::shm_name(&args.session_id);
        let shm = ShmWriter::create(
            &name,
            ShmLayout {
                banner: extractor.banner_size(),
                spec: extractor.spec_size(),
                thumb: (THUMB_W, THUMB_H),
                killfeed: extractor.killfeed_size(),
            },
        )
        .map_err(|e| failure(ErrorCode::Internal, e))?;
        let (notice_tx, notices) = mpsc::channel();
        let (segment_tx, segments) = mpsc::channel();
        let (small_tx, small) = mpsc::sync_channel(8);
        let (first_tx, first) = mpsc::sync_channel(1);
        let pipeline = Arc::new(OnceLock::new());
        let counts = Arc::new(Counts::default());
        let sdr_size = Arc::new(OnceLock::new());
        let opts = CaptureOptions {
            pid: args.pid,
            max_fps: fps,
            capture_cursor: args.capture_cursor,
            origin_ticks: 0,
            sdr_size: Some(sdr_size.clone()),
        };
        let consumer = Box::new(Consumer {
            pipeline: pipeline.clone(),
            extractor,
            small: small_tx,
            first: Some(first_tx),
            origin: None,
            small_bucket: None,
            counts: counts.clone(),
        });
        let capture = match prepared_hook {
            Some(prepared) => Capture::start_hook(prepared, &gpu, opts, consumer, notice_tx),
            None => Capture::start_with(args.capture, &gpu, opts, consumer, notice_tx),
        }
        .map_err(|e| failure(ErrorCode::CaptureFailed, e))?;
        let mut session = Self {
            announced: false,
            capture_origin: 0,
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
            audio_stall_warned: false,
            game_hidden: false,
            visibility_changes: VecDeque::new(),
        };
        let (source_w, source_h) = match session.notices.recv_timeout(Duration::from_secs(5)) {
            Ok(CaptureNotice::WindowFound { width, height, .. }) => (width, height),
            _ => return Err((ErrorCode::CaptureFailed, "Capture window dimensions unavailable".into())),
        };
        let (width, height) = if let Some(cfg) = &args.encode {
            output_size(source_w, source_h, cfg.height, cfg.aspect)
                .map_err(|e| failure(ErrorCode::BadRequest, e))?
        } else {
            (source_w, source_h)
        };
        let _ = sdr_size.set(if args.encode.is_some() {
            (width, height)
        } else {
            (0, 0)
        });
        if let Some(cfg) = &args.encode {
            session.index =
                Some(IndexWriter::create(dir).map_err(|e| failure(ErrorCode::Internal, e))?);
            let encoder_name = if matches!(args.capture, CaptureMethod::Dda | CaptureMethod::Hook) {
                dda_encoder(&gpu, cfg, &session.events)
            } else {
                // WGC keeps the user's explicit encoder semantics; DDA and Hook fall back to the capture adapter.
                cfg.encoder.clone()
            };
            session.writer = Some(Arc::new(
                SegmentWriter::open(
                    &gpu,
                    dir,
                    VideoParams {
                        width,
                        height,
                        fps,
                        codec: cfg.codec,
                        encoder: encoder_name,
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
                anyhow::anyhow!("Timed out waiting for the first frame: {e}"),
            )
        })?;
        session.capture_origin = origin;
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
            let warnings = session
                .audio
                .as_mut()
                .map(AudioCapture::drain_warnings)
                .unwrap_or_default();
            for warning in warnings {
                session.events.emit(&Event::Warning {
                    code: warning.code.into(),
                    message: warning.message,
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
                aditorrec_version: env!("CARGO_PKG_VERSION").into(),
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
                    && !self.audio_stall_warned
                    && clock::ticks_to_secs(
                        clock::now_ticks() - self.counts.last_audio.load(Ordering::Relaxed),
                    ) > 5.0
                {
                    // Audio loss is a degraded mode, never a reason to stop the video recording.
                    self.audio_stall_warned = true;
                    self.events.emit(&Event::Warning {
                        code: "audio_capture_stalled".into(),
                        message: "Audio capture has produced no output for over five seconds; continuing to record video with silence".into(),
                    });
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
        loop {
            let notice = self.notices.try_recv();
            match notice {
                Ok(CaptureNotice::GameHidden { pts }) => self.visibility_changes.push_back((pts, true)),
                Ok(CaptureNotice::GameVisible { pts }) => self.visibility_changes.push_back((pts, false)),
                _ => {}
            }
            match notice {
                Ok(CaptureNotice::Failed { message }) => {
                    return Err(failure(ErrorCode::CaptureFailed, message));
                }
                Ok(_) if !self.announced => {}
                Ok(CaptureNotice::WindowLost) => self.events.emit(&Event::WindowLost),
                Ok(CaptureNotice::GameHidden { pts }) => self.events.emit(&Event::GameHidden {
                    pts: clock::ticks_to_secs((pts - self.capture_origin).max(0)),
                }),
                Ok(CaptureNotice::GameVisible { pts }) => self.events.emit(&Event::GameVisible {
                    pts: clock::ticks_to_secs((pts - self.capture_origin).max(0)),
                }),
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
                    return Err((ErrorCode::CaptureFailed, "Capture management thread has exited".into()))
                }
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
        // After the notices, so a change in this batch already applies to samples captured after it.
        for mut small in self.small.try_iter() {
            if hidden_at(&mut self.game_hidden, &mut self.visibility_changes, small.pts) {
                blank_small_frames(&mut small);
            }
            self.shm
                .write(
                    small.pts,
                    &small.banner,
                    &small.spec,
                    small.thumb.as_deref(),
                    small.killfeed.as_deref(),
                )
                .map_err(|e| failure(ErrorCode::Internal, e))?;
        }
        let warnings = self
            .audio
            .as_mut()
            .map(AudioCapture::drain_warnings)
            .unwrap_or_default();
        for warning in warnings {
            self.events.emit(&Event::Warning {
                code: warning.code.into(),
                message: warning.message,
            });
        }
        if let Some(writer) = &self.writer {
            writer
                .check_error()
                .map_err(|e| failure(ErrorCode::EncodeFailed, e))?;
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
                format!(
                    "Encoder has processed no frames for over five seconds; {}",
                    self.writer.as_ref().unwrap().diagnostics()
                ),
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
                .map_err(|_| (ErrorCode::Internal, "Encoder references remain after stop".into()))
                .and_then(|writer| {
                    writer
                        .finish()
                        .map_err(|e| failure(ErrorCode::EncodeFailed, e))
                })
        } else {
            Ok(())
        };
        let drain = self.drain();
        let index = self.check_index();
        stats.and(finish).and(drain).and(index)
    }
    fn check_index(&self) -> Result<(), BackendError> {
        if self.index.is_some() {
            let entries = index::read_index(&self.dir.join("index.jsonl"))
                .map_err(|e| failure(ErrorCode::Internal, e))?;
            if entries.len() != self.published
                || entries
                    .iter()
                    .any(|entry| entry.dur > f64::from(SEGMENT_SECS) + 0.1)
            {
                return Err((ErrorCode::Internal, "Segment index differs from published events".into()));
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
    } else if message.contains("hook_unavailable:") {
        ErrorCode::HookUnavailable
    } else if message.contains("disk_full:") {
        ErrorCode::DiskFull
    } else {
        default
    };
    (code, message)
}
fn validate(args: &StartArgs) -> Result<()> {
    ensure!(args.pid != 0, "PID must be greater than zero");
    ensure!(
        !args.session_dir.is_empty() && !args.session_dir.contains('\0'),
        "Recording directory must not be empty or contain NUL"
    );
    let path = Path::new(&args.session_dir);
    ensure!(
        path.is_absolute()
            && matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
            && !path.components().any(|part| part == Component::ParentDir),
        "Recording directory must be an absolute local drive path without .."
    );
    ensure!(
        !args.session_id.is_empty()
            && args.session_id.len() <= 80
            && args
                .session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Session ID must contain 1–80 alphanumeric characters, hyphens, or underscores"
    );
    ensure!(args.frames.base == [1920, 1080], "Thumbnail reference resolution must be 1920×1080");
    for roi in [Some(args.frames.banner), Some(args.frames.spec), args.frames.killfeed].into_iter().flatten() {
        let rect = Rect::from_array(roi);
        ensure!(
            rect == rect.scaled((1920, 1080), (1920, 1080)),
            "Small-image ROI exceeds reference frame bounds"
        );
    }
    if let Some(cfg) = &args.encode {
        ensure!(
            (1..=144).contains(&cfg.fps)
                && (1..=1_000_000).contains(&cfg.bitrate_kbps)
                && (cfg.height == 0
                    || (2..=16_384).contains(&cfg.height) && cfg.height.is_multiple_of(2)),
            "FPS, output height, or bitrate is out of range"
        );
    }
    if let Some(cfg) = &args.audio {
        cfg.validate()?;
    }
    Ok(())
}
fn output_size(
    width: u32,
    height: u32,
    requested: u32,
    aspect: EncodeAspect,
) -> Result<(u32, u32)> {
    ensure!(width >= 2 && height >= 2, "Capture dimensions are too small");
    let h = if requested == 0 {
        height & !1
    } else {
        requested
    };
    let w = if aspect == EncodeAspect::Native {
        ((u64::from(width) * u64::from(h) / u64::from(height)) & !1) as u32
    } else {
        // Round to the nearest even number.
        ((u64::from(h) * 16 + 9) / 18 * 2) as u32
    };
    ensure!(
        (2..=16_384).contains(&w) && (2..=16_384).contains(&h),
        "Output dimensions exceed hardware encoding limits"
    );
    Ok((w, h))
}
fn check_disk(dir: &Path) -> Result<()> {
    let path: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    // SAFETY: The path is NUL-terminated and output points to a valid u64; only query free space for the current job.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(path.as_ptr()), Some(&mut available), None, None) }
        .context("Failed to query disk space")?;
    check_available(available)
}
fn check_available(available: u64) -> Result<()> {
    if available < DISK_RESERVE {
        bail!("disk_full: Less than 1 GiB of free space");
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
    // SAFETY: FILETIME is the current UTC time; utc is a valid output structure.
    unsafe { FileTimeToSystemTime(&filetime, &mut utc) }.context("Failed to convert recording start time")?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        utc.wYear, utc.wMonth, utc.wDay, utc.wHour, utc.wMinute, utc.wSecond, utc.wMilliseconds
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{io, sync::Mutex};

    #[test]
    fn late_samples_use_the_visibility_at_their_own_pts() {
        let mut hidden = false;
        let mut changes = VecDeque::from([(100, true), (200, false)]);
        // Captured before the game was hidden, read back after: keep it.
        assert!(!hidden_at(&mut hidden, &mut changes, 50));
        // Desktop frame captured while hidden, read back after the game returned: blank it.
        assert!(hidden_at(&mut hidden, &mut changes, 150));
        assert!(!hidden_at(&mut hidden, &mut changes, 200));
        assert!(changes.is_empty());
    }

    #[test]
    fn hidden_game_blanks_every_detection_buffer() {
        let mut small = SmallFrames {
            pts: 7,
            banner: vec![9; 4],
            spec: vec![9; 4],
            killfeed: Some(vec![9; 4]),
            thumb: Some(vec![9; 4]),
        };
        blank_small_frames(&mut small);
        assert_eq!(small.pts, 7);
        assert!(small
            .banner
            .iter()
            .chain(&small.spec)
            .chain(small.killfeed.iter().flatten())
            .chain(small.thumb.iter().flatten())
            .all(|&v| v == 0));
    }

    #[derive(Clone, Default)]
    struct Output(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Output {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Output {
        fn events(&self) -> Vec<Value> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
        fn sink(&self) -> EventSink {
            EventSink::new(Box::new(self.clone()))
        }
    }

    fn start_args() -> StartArgs {
        serde_json::from_value(json!({
            "pid": 42, "session_dir": "D:\\錄影\\.sessions\\test", "session_id": "test",
            "encode": null, "audio": null,
            "frames": {"banner": [1, 2, 3, 4], "spec": [5, 6, 7, 8], "base": [1920, 1080]}
        }))
        .unwrap()
    }

    #[test]
    fn runtime_capture_failures_preserve_the_specific_error_code() {
        let (notices_tx, notices) = mpsc::channel();
        let name = shm::shm_name(&format!("runtime-failure-{}", std::process::id()));
        let mut session = Session {
            announced: true,
            capture_origin: 0,
            dir: std::env::temp_dir(),
            published: 0,
            capture: None,
            audio: None,
            writer: None,
            index: None,
            shm: ShmWriter::create(
                &name,
                ShmLayout {
                    banner: (2, 2),
                    spec: (2, 2),
                    thumb: (2, 2),
                    killfeed: (0, 0),
                },
            )
            .unwrap(),
            segments: mpsc::channel().1,
            notices,
            small: mpsc::channel().1,
            counts: Arc::new(Counts::default()),
            events: Output::default().sink(),
            last_stats: Instant::now(),
            previous: EncodeStats::default(),
            audio_stall_warned: false,
            game_hidden: false,
            visibility_changes: VecDeque::new(),
        };
        for (message, expected) in [
            (
                "window_not_found: Game capture window disappeared",
                ErrorCode::WindowNotFound,
            ),
            (
                "hook_unavailable: Capture hook stopped",
                ErrorCode::HookUnavailable,
            ),
            ("Unexpected capture failure", ErrorCode::CaptureFailed),
        ] {
            notices_tx
                .send(CaptureNotice::Failed {
                    message: message.into(),
                })
                .unwrap();
            assert_eq!(session.drain().unwrap_err(), (expected, message.into()));
        }
    }

    #[test]
    fn session_paths_require_local_absolute_paths_without_parent_components() {
        let mut args = start_args();
        for path in [
            r"D:\錄影\.sessions\test",
            "C:/recordings/.sessions/test",
            r"E:\",
        ] {
            args.session_dir = path.into();
            assert!(validate(&args).is_ok(), "{path}");
        }
        for path in [
            "",
            "relative/path",
            r"\rooted",
            r"C:relative",
            r"\\server\share\rec",
            "//server/share/rec",
            r"\\?\C:\rec",
            r"\\.\C:\rec",
            "//?/C:/rec",
            r"\\?\UNC\server\share\rec",
            r"C:\rec\..\other",
            "C:/rec/../other",
            "C:\\rec\0other",
        ] {
            args.session_dir = path.into();
            let error = Recorder
                .start(args.clone(), Output::default().sink())
                .unwrap_err();
            assert_eq!(error.0, ErrorCode::BadRequest, "{path:?}");
        }
    }

    #[test]
    fn audio_gains_are_validated_before_opening_capture_including_disabled_audio() {
        let mut args = start_args();
        args.audio = Some(crate::types::AudioConfig::default());
        for gain in [0.0, 1.0, 2.0] {
            let audio = args.audio.as_mut().unwrap();
            audio.mic_gain = gain;
            audio.render_gain = gain;
            assert!(validate(&args).is_ok());
        }
        for mic in [true, false] {
            for gain in [
                -0.1,
                2.01,
                f32::MAX,
                f32::NAN,
                f32::INFINITY,
                f32::NEG_INFINITY,
            ] {
                let audio = args.audio.as_mut().unwrap();
                audio.mic_enabled = false;
                audio.render_enabled = false;
                audio.mic_gain = if mic { gain } else { 1.0 };
                audio.render_gain = if mic { 1.0 } else { gain };
                let error = Recorder
                    .start(args.clone(), Output::default().sink())
                    .unwrap_err();
                assert_eq!(error.0, ErrorCode::BadRequest, "{mic}: {gain}");
            }
        }
    }

    #[test]
    fn worker_guard_clears_active_and_emits_one_terminal_pair_on_panic() {
        let active = Arc::new(AtomicBool::new(true));
        let output = Output::default();
        let guard = WorkerGuard {
            active: active.clone(),
            events: output.sink(),
            announced: true,
            failure: None,
        };
        assert!(thread::spawn(move || {
            let _guard = guard;
            panic!("test session panic");
        })
        .join()
        .is_err());
        assert!(!active.load(Ordering::Acquire));
        let events = output.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["ev"], "error");
        assert_eq!(events[0]["code"], "internal");
        assert_eq!(events[1], json!({"ev": "stopped", "reason": "internal"}));
    }

    #[test]
    fn stop_after_async_failure_is_idempotent_and_preserves_terminal_reason() {
        for code in [
            ErrorCode::CaptureFailed,
            ErrorCode::EncodeFailed,
            ErrorCode::DiskFull,
        ] {
            let active = Arc::new(AtomicBool::new(true));
            let output = Output::default();
            let mut guard = WorkerGuard {
                active: active.clone(),
                events: output.sink(),
                announced: true,
                failure: None,
            };
            let (stop, _stopped) = mpsc::channel();
            let (done, finished) = mpsc::channel();
            let worker = thread::spawn(move || {
                let result = Err((code, "Test asynchronous failure".into()));
                guard.complete(&result);
                done.send(()).unwrap();
                result
            });
            finished.recv().unwrap();
            RUNNING.with_borrow_mut(|running| {
                *running = Some(Running {
                    active,
                    stop,
                    worker,
                })
            });
            let mut recorder = Recorder;
            assert!(!recorder.is_running());
            assert!(recorder.stop().is_ok());
            assert!(recorder.stop().is_ok());
            let events = output.events();
            assert_eq!(events.len(), 2);
            assert_eq!(events[0]["code"], code.as_str());
            assert_eq!(events[1], json!({"ev": "stopped", "reason": code.as_str()}));
        }
    }

    #[test]
    fn worker_guard_does_not_announce_stop_when_initialization_failed() {
        let active = Arc::new(AtomicBool::new(true));
        let output = Output::default();
        drop(WorkerGuard {
            active: active.clone(),
            events: output.sink(),
            announced: false,
            failure: None,
        });
        assert!(!active.load(Ordering::Acquire));
        assert!(output.events().is_empty());
    }

    #[test]
    fn original_error_is_emitted_once_before_cleanup_completes() {
        let active = Arc::new(AtomicBool::new(true));
        let output = Output::default();
        let mut guard = WorkerGuard {
            active: active.clone(),
            events: output.sink(),
            announced: true,
            failure: None,
        };
        let (reported, observed) = mpsc::channel();
        let (release, cleanup) = mpsc::channel();
        let worker = thread::spawn(move || {
            let error = (ErrorCode::EncodeFailed, "Test mux timeout".into());
            guard.report_error(&error);
            guard.report_error(&error);
            reported.send(()).unwrap();
            cleanup.recv().unwrap();
            guard.complete(&Err(error));
        });
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        let before_cleanup = output.events();
        let still_active = active.load(Ordering::Acquire);
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(still_active);
        assert_eq!(
            before_cleanup,
            vec![json!({"ev": "error", "code": "encode_failed", "message": "Test mux timeout"})]
        );
        let events = output.events();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[1],
            json!({"ev": "stopped", "reason": "encode_failed"})
        );
        assert!(!active.load(Ordering::Acquire));
    }

    #[test]
    fn panic_during_cleanup_keeps_the_previously_reported_failure() {
        let active = Arc::new(AtomicBool::new(true));
        let output = Output::default();
        let mut guard = WorkerGuard {
            active: active.clone(),
            events: output.sink(),
            announced: true,
            failure: None,
        };
        assert!(thread::spawn(move || {
            guard.report_error(&(ErrorCode::EncodeFailed, "Test mux timeout".into()));
            panic!("test cleanup panic");
        })
        .join()
        .is_err());
        let events = output.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["message"], "Test mux timeout");
        assert_eq!(
            events[1],
            json!({"ev": "stopped", "reason": "encode_failed"})
        );
        assert!(!active.load(Ordering::Acquire));
    }

    #[test]
    fn app_metadata_is_allowed_but_recorder_output_is_not() {
        let dir = std::env::temp_dir().join(format!("aditorrec-out-{}", std::process::id()));
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
            failure(ErrorCode::CaptureFailed, "hook_unavailable: 測試").0,
            ErrorCode::HookUnavailable
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

    fn adapter(vendor_id: u32, device_id: u32, software: bool) -> AdapterDesc {
        AdapterDesc {
            name: format!("GPU {vendor_id:04x}:{device_id:04x}"),
            vendor_id,
            device_id,
            software,
        }
    }

    #[test]
    fn adapter_names_are_filtered_by_vendor_family() {
        let names = ENCODERS;
        for (vendor, expected) in [
            (
                Vendor::Nvidia,
                ["hevc_nvenc", "h264_nvenc", "av1_nvenc"].as_slice(),
            ),
            (Vendor::Amd, ["hevc_amf", "h264_amf", "av1_amf"].as_slice()),
            (
                Vendor::Intel,
                ["hevc_qsv", "h264_qsv", "av1_qsv"].as_slice(),
            ),
        ] {
            assert_eq!(
                names_for_adapter(&names, vendor.encoder_family()),
                expected,
                "{vendor:?}"
            );
        }
        assert!(names_for_adapter(&names, None).is_empty());
        assert!(names_for_adapter(&names, Vendor::Other.encoder_family()).is_empty());
    }

    #[test]
    fn explicit_gpu_lookup_falls_back_to_automatic_vendor_order() {
        let descs = [
            adapter(0x8086, 1, false),
            adapter(0x10de, 2, false),
            adapter(0x1414, 3, true),
        ];
        let ids = vec!["8086:0001".into(), "10de:0002".into(), "1414:0003".into()];
        assert_eq!(
            choose_adapters("10de:0002", &ids, &descs),
            GpuChoice::Explicit(1)
        );
        assert_eq!(
            choose_adapters("auto", &ids, &descs),
            GpuChoice::Auto(vec![1, 0])
        );
        assert_eq!(
            choose_adapters("dead:beef", &ids, &descs),
            GpuChoice::Auto(vec![1, 0])
        );
    }

    #[test]
    fn dda_encoder_fallback_never_crosses_the_requested_codec() {
        let available = ["hevc_amf", "h264_amf"];
        assert_eq!(
            same_codec_fallback(Codec::H264, "h264_nvenc", &available),
            Some("h264_amf")
        );
        assert_eq!(
            same_codec_fallback(Codec::Hevc, "hevc_nvenc", &available),
            Some("hevc_amf")
        );
        assert_eq!(
            same_codec_fallback(Codec::Hevc, "hevc_nvenc", &["h264_amf"]),
            None,
            "falling back to H.264 would silently change the codec"
        );
        assert_eq!(
            same_codec_fallback(Codec::Av1, "av1_nvenc", &available),
            None
        );
        assert_eq!(
            same_codec_fallback(Codec::H264, "h264_amf", &available),
            None,
            "the requested encoder must not be selected again as its own fallback"
        );
    }

    #[test]
    fn hello_encoder_union_is_deduplicated_in_automatic_order() {
        let gpus = [
            GpuInfo {
                id: "8086:0001".into(),
                name: "Intel".into(),
                vendor: "intel".into(),
                encoders: vec!["av1_qsv".into()],
            },
            GpuInfo {
                id: "10de:0002".into(),
                name: "NVIDIA".into(),
                vendor: "nvidia".into(),
                encoders: vec!["h264_nvenc".into(), "hevc_nvenc".into()],
            },
        ];
        assert_eq!(
            encoder_union(&gpus),
            ["hevc_nvenc", "h264_nvenc", "av1_qsv"]
        );
    }

    #[test]
    fn hook_capture_without_hook_dir_returns_hook_unavailable() {
        let dir = std::env::temp_dir().join(format!("aditorrec-hook-nodir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut args = start_args();
        args.session_dir = dir.to_string_lossy().into_owned();
        args.capture = CaptureMethod::Hook;
        args.hook_dir = None;
        let err = Recorder.start(args, Output::default().sink()).unwrap_err();
        assert_eq!(err.0, ErrorCode::HookUnavailable);
        let _ = fs::remove_dir_all(&dir);
    }
}
