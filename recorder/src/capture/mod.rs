//! WGC capture (task B2). Find the Apex top-level window by PID and create a `GraphicsCaptureItem`;
//! reconnect when the window is recreated or stops delivering frames; fall back to monitor capture for black or minimized windows.
//! See `dda` for lower-latency full-display capture, selected by `Capture::start_with`.
//!
//! The scaffold defines the interface; implementations must preserve signatures and add new types in this module.

mod color;
mod cursor;
pub mod dda;
pub mod hook;
pub mod small;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use windows::core::{factory, IInspectable, Interface, BOOL};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_TEXTURE2D_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, HMONITOR, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsWindow,
    IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

use crate::clock::TICKS_PER_SEC;
use crate::gpu::Gpu;
pub use crate::types::CaptureMethod;
use small::LumaProbe;

/// Captured frame. `texture` is valid only during `on_frame` (owned by the WGC frame pool or DDA desktop image);
/// consumers must copy it on the GPU during the call to retain it (`CopyResource`/`CopySubresourceRegion`).
pub struct CapturedFrame<'a> {
    pub texture: &'a ID3D11Texture2D,
    /// Dimensions of the delivered texture, which may be smaller than the capture target.
    pub width: u32,
    pub height: u32,
    /// 100 ns ticks, with 0 at session start (see `clock`).
    pub pts: i64,
}

/// Called on the capture thread; **must not block** (only copy on the GPU and enqueue).
pub trait FrameConsumer: Send {
    fn on_frame(&mut self, frame: &CapturedFrame<'_>);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureNotice {
    Failed {
        message: String,
    },
    WindowLost,
    GameHidden {
        pts: i64,
    },
    GameVisible {
        pts: i64,
    },
    WindowFound {
        width: u32,
        height: u32,
        monitor: bool,
    },
}

#[derive(Debug, Clone)]
pub struct CaptureOptions {
    pub pid: u32,
    /// Maximum fps delivered to the consumer (drop excess frames, throttled by pts).
    pub max_fps: u32,
    pub capture_cursor: bool,
    /// QPC tick of the first frame (`clock::now_ticks()`); pts = frame system time − origin.
    pub origin_ticks: i64,
    /// Encoder dimensions, published after target discovery; unset keeps HDR at native size.
    /// None disables reduction; (0, 0) keeps only the analysis reference requirement.
    pub sdr_size: Option<Arc<OnceLock<(u32, u32)>>>,
}

pub struct Capture {
    stop: Sender<()>,
    worker: Option<JoinHandle<()>>,
}

impl Capture {
    /// Start WGC capture. Return an error containing `window_not_found` if no window is found.
    #[allow(dead_code)] // Integration tests include this file with #[path]; production always uses start_with.
    pub fn start(
        gpu: &Gpu,
        opts: CaptureOptions,
        consumer: Box<dyn FrameConsumer>,
        notices: Sender<CaptureNotice>,
    ) -> Result<Self> {
        Self::start_with(CaptureMethod::Wgc, gpu, opts, consumer, notices)
    }

    /// Start capture using the selected method. For DDA, `gpu` must be created on the adapter owning the game's display
    /// (see `dda::gpu_for_pid`), otherwise return `capture_failed`.
    pub fn start_with(
        method: CaptureMethod,
        gpu: &Gpu,
        opts: CaptureOptions,
        consumer: Box<dyn FrameConsumer>,
        notices: Sender<CaptureNotice>,
    ) -> Result<Self> {
        if method == CaptureMethod::Hook {
            bail!("capture_failed: Game capture requires start_hook");
        }
        let gpu = gpu.clone();
        Self::spawn_worker(
            opts,
            notices,
            move |opts, notices, stopped, ready| match method {
                CaptureMethod::Wgc => run(gpu, opts, consumer, notices, stopped, ready),
                CaptureMethod::Dda => dda::run(gpu, opts, consumer, notices, stopped, ready),
                CaptureMethod::Hook => Err(anyhow::anyhow!(
                    "capture_failed: Game capture requires start_hook"
                )),
            },
        )
    }

    /// Start capture with a prepared hook; `gpu` must be the device returned by `hook::prepare`.
    pub fn start_hook(
        prepared: hook::Prepared,
        gpu: &Gpu,
        opts: CaptureOptions,
        consumer: Box<dyn FrameConsumer>,
        notices: Sender<CaptureNotice>,
    ) -> Result<Self> {
        let gpu = gpu.clone();
        Self::spawn_worker(opts, notices, move |opts, notices, stopped, ready| {
            hook::run(prepared, gpu, opts, consumer, notices, stopped, ready)
        })
    }

    fn spawn_worker(
        opts: CaptureOptions,
        notices: Sender<CaptureNotice>,
        task: impl FnOnce(
                CaptureOptions,
                Sender<CaptureNotice>,
                Receiver<()>,
                &mpsc::SyncSender<Result<()>>,
            ) -> Result<()>
            + Send
            + 'static,
    ) -> Result<Self> {
        if opts.max_fps == 0 || opts.max_fps > TICKS_PER_SEC as u32 {
            bail!("capture_failed: max_fps must be between 1 and 10000000");
        }
        let (stop, stopped) = mpsc::channel();
        let (ready, initialized) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("aditorrec-capture".into())
            .spawn(move || {
                if let Err(error) = task(opts, notices.clone(), stopped, &ready) {
                    report_failure(error, &ready, &notices);
                }
            })
            .context("capture_failed: Failed to create capture thread")?;
        let mut capture = Self {
            stop,
            worker: Some(worker),
        };
        match initialized
            .recv()
            .context("capture_failed: Capture initialization interrupted")?
        {
            Ok(()) => Ok(capture),
            Err(error) => {
                capture.shutdown();
                Err(error)
            }
        }
    }

    /// Stop capture and wait for the capture thread to exit.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                eprintln!("Capture thread exited unexpectedly");
            }
        }
    }
}

fn report_failure(
    error: anyhow::Error,
    ready: &mpsc::SyncSender<Result<()>>,
    notices: &Sender<CaptureNotice>,
) {
    let message = format!("{error:#}");
    // After initialization, the ready receiver may be dropped or the success notification unread; always report termination through notices separately.
    let _ = notices.send(CaptureNotice::Failed {
        message: message.clone(),
    });
    let _ = ready.try_send(Err(error));
    eprintln!("Capture thread exited: {message}");
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Apartment;

impl Apartment {
    fn new() -> Result<Self> {
        // SAFETY: Initialize the dedicated thread as MTA; Drop balances successful initialization on the same thread.
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).context("capture_failed: Failed to initialize WinRT")?
        };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: Balance this thread's successful RoInitialize exactly once; WinRT objects have already been released.
        unsafe { RoUninitialize() };
    }
}

struct WindowSearch {
    pid: u32,
    best: Option<HWND>,
    area: i64,
}

unsafe extern "system" fn enum_window(hwnd: HWND, data: LPARAM) -> BOOL {
    // SAFETY: EnumWindows is synchronous; data points to the uniquely mutable WindowSearch throughout enumeration.
    let search = unsafe { &mut *(data.0 as *mut WindowSearch) };
    let mut pid = 0;
    let mut rect = RECT::default();
    // SAFETY: Only query the enumerated HWND and PID without opening the target process; all output pointers are valid.
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == search.pid
            && IsWindowVisible(hwnd).as_bool()
            && GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW.0 as isize == 0
            && GetWindowRect(hwnd, &mut rect).is_ok()
        {
            let width = (rect.right as i64 - rect.left as i64).max(0);
            let height = (rect.bottom as i64 - rect.top as i64).max(0);
            let area = width * height;
            if area > search.area {
                search.best = Some(hwnd);
                search.area = area;
            }
        }
    }
    true.into()
}

pub(in crate::capture) fn find_window(pid: u32) -> Result<HWND> {
    let mut search = WindowSearch {
        pid,
        best: None,
        area: 0,
    };
    // SAFETY: The callback runs synchronously without retaining search pointers; all paths continue enumeration.
    unsafe {
        EnumWindows(
            Some(enum_window),
            LPARAM((&mut search as *mut WindowSearch) as isize),
        )
    }
    .context("capture_failed: Failed to enumerate windows")?;
    search
        .best
        .with_context(|| format!("window_not_found: No visible window found for PID {pid}"))
}

pub(in crate::capture) fn window_matches(hwnd: HWND, pid: u32) -> bool {
    let mut actual_pid = 0;
    // SAFETY: HWND may be stale; these queries safely report failure and only read window information.
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut actual_pid));
        actual_pid == pid && IsWindow(Some(hwnd)).as_bool() && IsWindowVisible(hwnd).as_bool()
    }
}

/// Limit average frame rate using QPC time buckets so slight 60 Hz timestamp jitter does not reduce frame-interval comparisons to 30 fps.
struct FrameGate {
    fps: u32,
    last_bucket: Option<i64>,
}

impl FrameGate {
    fn new(fps: u32) -> Self {
        Self {
            fps,
            last_bucket: None,
        }
    }

    fn accept(&mut self, pts: i64) -> bool {
        if pts < 0 {
            return false;
        }
        let bucket = (pts as i128 * self.fps as i128 / TICKS_PER_SEC as i128) as i64;
        if self.last_bucket.is_some_and(|last| bucket <= last) {
            return false;
        }
        self.last_bucket = Some(bucket);
        true
    }
}

#[derive(Default)]
struct BlackStreak {
    since: Option<i64>,
    last: Option<i64>,
}

impl BlackStreak {
    fn observe(&mut self, pts: i64, black: bool) -> bool {
        if !black {
            self.since = None;
            self.last = None;
            return false;
        }
        // Missing frames do not count as consecutive black frames; restart timing after a readback gap longer than two thumbnail intervals.
        if self
            .last
            .is_some_and(|last| pts <= last || pts - last > 2 * TICKS_PER_SEC)
        {
            self.since = None;
        }
        self.last = Some(pts);
        let since = *self.since.get_or_insert(pts);
        pts - since >= 3 * TICKS_PER_SEC
    }
}

struct CallbackState {
    pid: u32,
    gpu: Gpu,
    device: IDirect3DDevice,
    consumer: Box<dyn FrameConsumer>,
    gate: dda::SlotGate,
    origin: i64,
    probe: LumaProbe,
    color: color::SdrConverter,
    pool_monitor: Option<HMONITOR>,
    pool_format: DirectXPixelFormat,
    pool_refresh: Instant,
    hwnd: HWND,
    black: BlackStreak,
    visibility: dda::Visibility,
    monitor_black: Option<dda::BlackFrame>,
    notices: Sender<CaptureNotice>,
}

// SAFETY: device is an agile WinRT wrapper for D3D11; probe uses the shared device with multithread protection
// enabled, and consumer guarantees Send; all state access is additionally serialized with a Mutex.
unsafe impl Send for CallbackState {}

struct Signals {
    alive: AtomicBool,
    closed: AtomicBool,
    fallback: AtomicBool,
    size: AtomicU64,
    dropped: AtomicU64,
    last_frame: AtomicU64,
}

fn capture_stalled(last_frame: u64, now: u64) -> bool {
    now.saturating_sub(last_frame) >= 3 * TICKS_PER_SEC as u64
}

fn pack_size(size: SizeInt32) -> u64 {
    (size.Width as u64) << 32 | size.Height as u32 as u64
}

struct ActiveCapture {
    hwnd: HWND,
    monitor: bool,
    minimized_fallback: bool,
    /// Actual monitor of a fallback display capture; `None` for window captures.
    monitor_target: Option<HMONITOR>,
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    frame_token: Option<i64>,
    closed_token: Option<i64>,
    signals: Arc<Signals>,
}

/// Whether a monitor-fallback capture must be rebuilt because the window now sits on another display.
/// Window captures follow the window themselves and never need this check.
fn monitor_moved(captured: Option<HMONITOR>, current: HMONITOR) -> bool {
    captured.is_some_and(|captured| captured != current)
}

impl ActiveCapture {
    fn new(
        hwnd: HWND,
        monitor: bool,
        minimized_fallback: bool,
        opts: &CaptureOptions,
        shared: &Arc<Mutex<CallbackState>>,
    ) -> Result<Self> {
        let interop: IGraphicsCaptureItemInterop =
            factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        // Resolve the monitor once so the item and the change detector always reference the same display.
        let monitor_target = if monitor {
            // SAFETY: HWND is a visible top-level window for this PID; the monitor is only queried.
            Some(unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) })
        } else {
            None
        };
        // SAFETY: HWND is a visible top-level window for this PID; display capture uses its valid HMONITOR.
        let item: GraphicsCaptureItem = unsafe {
            match monitor_target {
                Some(monitor) => interop.CreateForMonitor(monitor)?,
                None => interop.CreateForWindow(hwnd)?,
            }
        };
        let size = item.Size()?;
        if size.Width <= 0 || size.Height <= 0 {
            bail!("capture_failed: Invalid capture target dimensions");
        }
        // SAFETY: Querying the capture window monitor does not mutate the window.
        let monitor_handle = monitor_target
            .unwrap_or_else(|| unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) });
        let display = color::display_state(monitor_handle);
        let format = display.pool_format();
        let device = {
            let mut state = shared
                .lock()
                .map_err(|_| anyhow::anyhow!("capture_failed: Capture state is poisoned"))?;
            state.hwnd = hwnd;
            state.pool_monitor = monitor_target;
            state.pool_format = format;
            state.pool_refresh = Instant::now() + Duration::from_secs(1);
            state.black = BlackStreak::default();
            state.probe.reset();
            state.monitor_black = if monitor {
                Some(dda::BlackFrame::new(
                    &state.gpu,
                    (size.Width as u32, size.Height as u32),
                )?)
            } else {
                None
            };
            state.device.clone()
        };
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&device, format, 2, size)?;
        let session = pool.CreateCaptureSession(&item)?;
        if let Err(error) = session.SetIsCursorCaptureEnabled(opts.capture_cursor) {
            // The cursor property needs Windows 10 2004+; failing to set it must not abort capture.
            eprintln!("WGC: Could not configure cursor capture: {error}");
        }
        // Older Windows versions lack these two interfaces; capture still works without them.
        let _ = session.SetIsBorderRequired(false);
        // Half a frame: a full-frame interval makes WGC skip frames presented slightly early, which the encoder then fills with duplicates.
        let _ = session.SetMinUpdateInterval(TimeSpan {
            Duration: TICKS_PER_SEC / opts.max_fps as i64 / 2,
        });
        let signals = Arc::new(Signals {
            alive: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            fallback: AtomicBool::new(false),
            size: AtomicU64::new(pack_size(size)),
            dropped: AtomicU64::new(0),
            last_frame: AtomicU64::new(crate::clock::now_ticks() as u64),
        });
        let mut active = Self {
            hwnd,
            monitor,
            minimized_fallback,
            monitor_target,
            item,
            pool,
            session,
            frame_token: None,
            closed_token: None,
            signals,
        };
        let closed = active.signals.clone();
        active.closed_token = Some(active.item.Closed(&TypedEventHandler::<
            GraphicsCaptureItem,
            IInspectable,
        >::new(move |_, _| {
            closed.closed.store(true, Ordering::Release);
            Ok(())
        }))?);
        let state = shared.clone();
        let signals = active.signals.clone();
        active.frame_token = Some(active.pool.FrameArrived(&TypedEventHandler::<
            Direct3D11CaptureFramePool,
            IInspectable,
        >::new(move |pool, _| {
            if !signals.alive.load(Ordering::Acquire) {
                return Ok(());
            }
            let Some(pool) = pool.as_ref() else {
                return Ok(());
            };
            // try_lock never waits for the previous callback; the pool holds two frames, so count and drop frames when behind.
            let Ok(mut state) = state.try_lock() else {
                signals.dropped.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            };
            if !signals.alive.load(Ordering::Acquire) {
                return Ok(());
            }
            if let Err(error) = state.frame(pool, monitor, minimized_fallback, &signals) {
                eprintln!("Capture callback failed: {error:#}");
                signals.closed.store(true, Ordering::Release);
            }
            Ok(())
        }))?);
        active.session.StartCapture()?;
        Ok(active)
    }

    fn announce(&self, notices: &Sender<CaptureNotice>) {
        let size = self.signals.size.load(Ordering::Acquire);
        let _ = notices.send(CaptureNotice::WindowFound {
            width: (size >> 32) as u32,
            height: size as u32,
            monitor: self.monitor,
        });
    }
}

impl Drop for ActiveCapture {
    fn drop(&mut self) {
        self.signals.alive.store(false, Ordering::Release);
        if let Some(token) = self.frame_token.take() {
            let _ = self.pool.RemoveFrameArrived(token);
        }
        if let Some(token) = self.closed_token.take() {
            let _ = self.item.RemoveClosed(token);
        }
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

struct Frame(Direct3D11CaptureFrame);

impl Drop for Frame {
    fn drop(&mut self) {
        let _ = self.0.Close();
    }
}

impl CallbackState {
    fn frame(
        &mut self,
        pool: &Direct3D11CaptureFramePool,
        monitor: bool,
        minimized_fallback: bool,
        signals: &Signals,
    ) -> Result<()> {
        let frame = Frame(pool.TryGetNextFrame()?);
        let size = frame.0.ContentSize()?;
        if size.Width <= 0 || size.Height <= 0 {
            return Ok(());
        }
        let raw_pts = frame.0.SystemRelativeTime()?.Duration - self.origin;
        let resized = signals.size.load(Ordering::Acquire) != pack_size(size);
        // SAFETY: Querying the capture window monitor does not mutate the window.
        let monitor_handle = self
            .pool_monitor
            .unwrap_or_else(|| unsafe { MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST) });
        let display = if Instant::now() >= self.pool_refresh {
            let display = color::display_state(monitor_handle);
            self.pool_refresh = Instant::now() + Duration::from_secs(1);
            Some(display)
        } else {
            None
        };
        let format = display.map_or(self.pool_format, color::DisplayState::pool_format);
        if let Some(pts) = self.gate.accept(raw_pts) {
            let visible = if monitor {
                // Minimized fallback stays black until window capture resumes, including the restore polling gap.
                if let Some(notice) = self.visibility.update(self.pid, pts, || {
                    if minimized_fallback { (None, true) } else { dda::foreground_state(Some(self.hwnd)) }
                }) {
                    let _ = self.notices.send(notice);
                }
                self.visibility.is_visible()
            } else {
                // A monitor fallback may have hidden the game before capture was rebuilt as a window. Window capture
                // records only the game itself, so it is visible regardless of which window has focus.
                if !self.visibility.is_visible() {
                    let pid = self.pid;
                    if let Some(notice) = self.visibility.update(pid, pts, || (Some(pid), false)) {
                        let _ = self.notices.send(notice);
                    }
                }
                true
            };
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            let access: IDirect3DDxgiInterfaceAccess = frame.0.Surface()?.cast()?;
            // SAFETY: WGC Surface implements IDirect3DDxgiInterfaceAccess to obtain the D3D11 texture on the same device.
            let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
            // SAFETY: texture is valid while the Frame guard lives; desc is a writable descriptor.
            unsafe { texture.GetDesc(&mut desc) };
            if resized && monitor {
                self.monitor_black = Some(dda::BlackFrame::new(
                    &self.gpu,
                    (size.Width as u32, size.Height as u32),
                )?);
            }
            // Resizing can leave an old-sized surface in the pool; consumers require exact texture dimensions.
            if desc.Width == size.Width as u32 && desc.Height == size.Height as u32 {
                if monitor && !visible {
                    self.monitor_black
                        .as_ref()
                        .context("capture_failed: Missing monitor black frame")?
                        .deliver(&mut *self.consumer, pts);
                } else {
                    let texture = self.color.convert(&texture, monitor_handle)?;
                    // SAFETY: The converted texture is owned locally through all consumers.
                    unsafe { texture.GetDesc(&mut desc) };
                    self.consumer.on_frame(&CapturedFrame {
                        texture: &texture,
                        width: desc.Width,
                        height: desc.Height,
                        pts,
                    });
                    if !monitor {
                        if let Some((pts, black)) = self.probe.on_frame(
                            &texture,
                            (desc.Width, desc.Height),
                            pts,
                        )? {
                            if self.black.observe(pts, black) {
                                signals.fallback.store(true, Ordering::Release);
                            }
                        }
                    }
                }
                signals
                    .last_frame
                    .store(crate::clock::now_ticks() as u64, Ordering::Release);
            }
        } else {
            signals.dropped.fetch_add(1, Ordering::Relaxed);
        }
        // Return the old frame before recreating the pool for size or display mode changes.
        drop(frame);
        if resized || format != self.pool_format {
            pool.Recreate(&self.device, format, 2, size)?;
            if format != self.pool_format {
                self.pool_format = format;
                if let Some(display) = display {
                    display.log_pool_format();
                }
            }
        }
        if resized {
            signals.size.store(pack_size(size), Ordering::Release);
            let _ = self.notices.send(CaptureNotice::WindowFound {
                width: size.Width as u32,
                height: size.Height as u32,
                monitor,
            });
        }
        Ok(())
    }
}

fn run(
    gpu: Gpu,
    opts: CaptureOptions,
    consumer: Box<dyn FrameConsumer>,
    notices: Sender<CaptureNotice>,
    stopped: Receiver<()>,
    ready: &mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    let _apartment = Apartment::new()?;
    let hwnd = find_window(opts.pid)?;
    let dxgi: IDXGIDevice = gpu.device.cast()?;
    // SAFETY: dxgi is the shared D3D11 device; the returned WinRT wrapper preserves GPU device identity.
    let device = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
    let probe = LumaProbe::new(&gpu).context("capture_failed: Failed to create black-frame detector")?;
    let shared = Arc::new(Mutex::new(CallbackState {
        pid: opts.pid,
        gpu: gpu.clone(),
        device,
        consumer,
        gate: dda::SlotGate::new(opts.max_fps),
        origin: opts.origin_ticks,
        probe,
        color: color::SdrConverter::new(&gpu, opts.sdr_size.clone())?,
        pool_monitor: None,
        pool_format: DirectXPixelFormat::R16G16B16A16Float,
        pool_refresh: Instant::now(),
        hwnd,
        black: BlackStreak::default(),
        visibility: dda::Visibility::new(),
        monitor_black: None,
        notices: notices.clone(),
    }));
    let mut active = Some(
        ActiveCapture::new(hwnd, false, false, &opts, &shared)
            .context("capture_failed: Failed to create WGC capture")?,
    );
    if let Some(capture) = &active {
        capture.announce(&notices);
    }
    let _ = ready.send(Ok(()));
    let mut next_check = Instant::now() + Duration::from_secs(1);
    loop {
        match stopped.recv_timeout(Duration::from_millis(100)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() < next_check {
            continue;
        }
        next_check = Instant::now() + Duration::from_secs(1);
        // A closed item or an HWND that no longer belongs to the target PID invalidates the capture.
        // Check this before any rebuild so a reused HWND owned by another process is never captured.
        let lost = active.as_ref().is_some_and(|capture| {
            capture.signals.closed.load(Ordering::Acquire) || !window_matches(capture.hwnd, opts.pid)
        });
        // SAFETY: Query only; restore window capture after the minimized fallback ends.
        let restored = active.as_ref().is_some_and(|capture| {
            capture.minimized_fallback && !unsafe { IsIconic(capture.hwnd).as_bool() }
        });
        if lost || restored {
            drop(active.take());
            // A restore is rebuilt as window capture below; the window was never lost.
            if lost {
                let _ = notices.send(CaptureNotice::WindowLost);
            }
        }
        if let Some(capture) = &active {
            // A static window also stops delivering frames; silence alone must not widen capture to the desktop.
            if (!capture.monitor && capture.signals.fallback.load(Ordering::Acquire))
                || capture_stalled(
                    capture.signals.last_frame.load(Ordering::Acquire),
                    crate::clock::now_ticks() as u64,
                )
            {
                let hwnd = capture.hwnd;
                let black = capture.signals.fallback.load(Ordering::Acquire);
                // SAFETY: This query only reads the target window's current minimized state.
                let minimized = unsafe { IsIconic(hwnd).as_bool() };
                let monitor = capture.monitor || black || minimized;
                let minimized_fallback = capture.minimized_fallback || (!capture.monitor && !black && minimized);
                drop(active.take());
                match ActiveCapture::new(hwnd, monitor, minimized_fallback, &opts, &shared) {
                    Ok(capture) => {
                        capture.announce(&notices);
                        active = Some(capture);
                    }
                    Err(error) => {
                        eprintln!("Failed to recover capture: {error:#}");
                        let _ = notices.send(CaptureNotice::WindowLost);
                    }
                }
            }
        }
        let moved = active.as_ref().and_then(|capture| {
            let captured = capture.monitor_target?;
            // SAFETY: The HWND belongs to the target PID and is only queried for its current monitor.
            let current = unsafe { MonitorFromWindow(capture.hwnd, MONITOR_DEFAULTTONEAREST) };
            monitor_moved(Some(captured), current).then_some((capture.hwnd, capture.minimized_fallback))
        });
        if let Some((hwnd, minimized_fallback)) = moved {
            // Stop the old monitor capture before creating the new item; on failure `active` stays
            // None, so the old desktop can never keep being recorded.
            drop(active.take());
            match ActiveCapture::new(hwnd, true, minimized_fallback, &opts, &shared) {
                Ok(capture) => {
                    capture.announce(&notices);
                    active = Some(capture);
                }
                Err(error) => {
                    eprintln!("Failed to move display capture to the new monitor: {error:#}");
                    let _ = notices.send(CaptureNotice::WindowLost);
                }
            }
        }
        if active.is_none() {
            if let Ok(hwnd) = find_window(opts.pid) {
                match ActiveCapture::new(hwnd, false, false, &opts, &shared) {
                    Ok(capture) => {
                        capture.announce(&notices);
                        active = Some(capture);
                    }
                    Err(error) => eprintln!("Failed to recreate window capture: {error:#}"),
                }
            }
        } else if let Some(capture) = &active {
            // Query target dimensions every second even without new frames; recreate after the next FrameArrived returns the frame.
            if let Ok(size) = capture.item.Size() {
                if size.Width <= 0 || size.Height <= 0 {
                    capture.signals.closed.store(true, Ordering::Release);
                }
            }
        }
    }
    // Close callbacks and the pool before releasing the consumer and WinRT apartment.
    drop(active);
    // Callbacks started before closing must finish; only the capture management thread waits, while callbacks still use try_lock.
    drop(
        shared
            .lock()
            .map_err(|_| anyhow::anyhow!("capture_failed: Capture state is poisoned"))?,
    );
    drop(shared);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_frames_trigger_recovery_after_three_seconds() {
        let second = TICKS_PER_SEC as u64;
        assert!(!capture_stalled(second, 4 * second - 1));
        assert!(capture_stalled(second, 4 * second));
        assert!(!capture_stalled(4 * second, 4 * second));
        assert!(!capture_stalled(4 * second, second));
    }

    #[test]
    fn terminal_errors_reach_notices_before_and_after_initialization() {
        for initialized in [false, true] {
            let (ready, receiver) = mpsc::sync_channel(1);
            let (notices, received) = mpsc::channel();
            if initialized {
                ready.send(Ok(())).unwrap();
            }
            report_failure(anyhow::anyhow!("Test capture failed"), &ready, &notices);
            assert_eq!(
                received.recv().unwrap(),
                CaptureNotice::Failed {
                    message: "Test capture failed".into()
                }
            );
            assert_eq!(receiver.recv().unwrap().is_ok(), initialized);
        }
        let (ready, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let (notices, received) = mpsc::channel();
        report_failure(
            anyhow::anyhow!("Capture failed after initialization"),
            &ready,
            &notices,
        );
        assert!(matches!(
            received.recv().unwrap(),
            CaptureNotice::Failed { .. }
        ));
    }

    #[test]
    fn throttles_by_qpc_and_rejects_backwards_timestamps() {
        let mut gate = FrameGate::new(4);
        assert!(!gate.accept(-1));
        assert!(gate.accept(0));
        assert!(!gate.accept(1));
        assert!(!gate.accept(TICKS_PER_SEC / 4 - 1));
        assert!(gate.accept(TICKS_PER_SEC / 4));
        assert!(!gate.accept(0));
        assert!(gate.accept(10 * TICKS_PER_SEC));
        assert!(!gate.accept(10 * TICKS_PER_SEC));
    }

    #[test]
    fn monitor_fallback_rebuilds_only_when_the_window_moves_to_another_display() {
        let monitor = |value: usize| HMONITOR(value as *mut core::ffi::c_void);
        assert!(!monitor_moved(None, monitor(2)));
        assert!(!monitor_moved(Some(monitor(1)), monitor(1)));
        assert!(monitor_moved(Some(monitor(1)), monitor(2)));
    }

    #[test]
    fn black_fallback_requires_three_seconds_of_continuous_samples() {
        let mut streak = BlackStreak::default();
        for second in 0..3 {
            assert!(!streak.observe(second * TICKS_PER_SEC, true));
        }
        assert!(streak.observe(3 * TICKS_PER_SEC, true));
        assert!(!streak.observe(4 * TICKS_PER_SEC, false));
        assert!(!streak.observe(5 * TICKS_PER_SEC, true));
        assert!(!streak.observe(9 * TICKS_PER_SEC, true));
        assert!(!streak.observe(10 * TICKS_PER_SEC, false));
    }

    #[test]
    fn monitor_fallback_visibility_hides_and_recovers_on_foreground_changes() {
        let mut visibility = dda::Visibility::new();
        assert!(visibility.is_visible());
        assert_eq!(visibility.update(42, 0, || (Some(42), false)), None);
        assert_eq!(
            visibility.update(42, 1, || (Some(7), false)),
            Some(CaptureNotice::GameHidden { pts: 1 })
        );
        assert!(!visibility.is_visible());
        assert_eq!(
            visibility.update(42, 1, || panic!("duplicate visibility query")),
            None
        );
        assert_eq!(
            visibility.update(42, 2, || (Some(42), false)),
            Some(CaptureNotice::GameVisible { pts: 2 })
        );
        assert!(visibility.is_visible());
    }

    struct NoopConsumer;
    impl FrameConsumer for NoopConsumer {
        fn on_frame(&mut self, _frame: &CapturedFrame<'_>) {}
    }

    #[test]
    fn start_with_rejects_hook_method() {
        let gpu = Gpu::create().unwrap();
        let (notices, _rx) = mpsc::channel();
        let err = match Capture::start_with(
            CaptureMethod::Hook,
            &gpu,
            CaptureOptions {
                pid: 1,
                max_fps: 60,
                capture_cursor: false,
                origin_ticks: 0,
                sdr_size: None,
            },
            Box::new(NoopConsumer),
            notices,
        ) {
            Ok(_) => panic!("CaptureMethod::Hook must not be started through start_with"),
            Err(err) => err.to_string(),
        };
        assert_eq!(err, "capture_failed: Game capture requires start_hook");
    }
}
