//! DXGI Desktop Duplication capture (DDA). Captures the entire monitor containing the Apex window:
//! WGC window capture may make a fullscreen game leave independent flip and be composited by DWM, adding one frame of latency;
//! DDA reads the entire output desktop and does not request composition for a game window (latency differences require an on-device A/B test).
//! Like WGC, this is an official Windows API and does not inject into or access the game process.
//!
//! - Frames: pass the DDA desktop texture directly to the consumer, then release it after the consumer returns to avoid a full-frame copy.
//!   Calls ReleaseFrame after the consumer returns, avoiding one full-frame copy.
//! - Optionally composite the separately supplied desktop cursor after SDR conversion.
//! - When the foreground window does not belong to the target PID or is minimized, continuously sends GPU black frames to avoid recording another app.
//! - DXGI_ERROR_ACCESS_LOST (resolution change, fullscreen transition, UAC secure desktop): discard and recreate duplication.
//! - Rotated monitors retain panel native orientation. FP16 HDR desktops are tone-mapped to SDR on the GPU.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use windows::core::{Interface, HRESULT};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_MODE_ROTATION,
    DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIDevice, IDXGIFactory1, IDXGIOutput, IDXGIOutput1,
    IDXGIOutput5, IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST,
    DXGI_ERROR_DEVICE_REMOVED, DXGI_ERROR_DEVICE_RESET, DXGI_ERROR_NOT_FOUND,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, HMONITOR, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::Performance::QueryPerformanceFrequency;
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
};

use super::{
    find_window, window_matches, CaptureNotice, CaptureOptions, CapturedFrame, FrameConsumer,
};
use crate::clock;
use crate::gpu::Gpu;

/// Poll interval bounds. AcquireNextFrame holds the shared device multithread lock while waiting, so poll with a 0 timeout and sleep outside the lock.
/// blocking encoding and thumbnails (the audio queue has filled as a result), so always poll with a 0 timeout and sleep outside the lock.
const POLL_MIN: Duration = Duration::from_millis(1);
const POLL_MAX: Duration = Duration::from_millis(8);
/// Recreation interval after duplication becomes invalid (continues failing on the UAC desktop or during mode changes).
const RETRY_INTERVAL: Duration = Duration::from_millis(250);
/// Notify with WindowLost only after recreation has failed for this long, avoiding notifications during brief fullscreen transitions.
const LOST_AFTER: Duration = Duration::from_secs(3);
/// Interval for checking whether the game window still exists and moved to another monitor.
const WINDOW_CHECK: Duration = Duration::from_secs(1);
/// `LastPresentTime` older than this value (100 ms) is treated as stale and replaced with the current time.
const MAX_PRESENT_AGE: i64 = clock::TICKS_PER_SEC / 10;

/// Finds the game window monitor by PID and creates a shared device on its adapter.
/// DDA can only copy from a device on the output adapter (common on dual-GPU laptops where the monitor is connected to the integrated GPU).
pub fn gpu_for_pid(pid: u32) -> Result<Gpu> {
    let monitor = monitor_of(find_window(pid)?);
    // SAFETY: Creating a DXGI factory has no additional preconditions; the windows crate manages the returned COM object.
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.context("capture_failed: Failed to create DXGI factory")?;
    let mut adapters = Vec::new();
    for index in 0.. {
        // SAFETY: Enumerate in order; an out-of-range index returns DXGI_ERROR_NOT_FOUND.
        match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => {
                let adapter: IDXGIAdapter = adapter.cast()?;
                let monitors: Vec<isize> = output_monitors(&adapter)?
                    .into_iter()
                    .map(|(_, monitor)| monitor)
                    .collect();
                adapters.push((adapter, monitors));
            }
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => {
                return Err(error).context("capture_failed: Failed to enumerate adapters")
            }
        }
    }
    let monitors: Vec<Vec<isize>> = adapters.iter().map(|(_, m)| m.clone()).collect();
    let (adapter, _) = locate(&monitors, monitor.0 as isize)
        .context("capture_failed: Could not find the DXGI output for the game monitor")?;
    Gpu::create_on(&adapters[adapter].0).context(
        "capture_failed: Could not create a D3D11 device on the adapter driving the game monitor",
    )
}

/// Finds the target monitor in each adapter output HMONITOR list and returns (adapter index, output index).
/// A monitor appears on only one adapter; if duplicated, use the first in enumeration order.
fn locate(adapters: &[Vec<isize>], monitor: isize) -> Option<(usize, usize)> {
    adapters.iter().enumerate().find_map(|(adapter, outputs)| {
        outputs
            .iter()
            .position(|&m| m == monitor)
            .map(|output| (adapter, output))
    })
}

/// Stable key for a DXGI adapter LUID. Adapter identity is the only safe way to tell "the monitor
/// moved to another adapter" apart from "the monitor is temporarily absent or enumeration changed".
fn luid_key(high: i32, low: u32) -> u64 {
    (u64::from(high as u32) << 32) | u64::from(low)
}

/// Returns the index of an adapter that owns `monitor` and whose LUID differs from `own_luid`.
/// A single adapter snapshot is used so a moving display topology cannot create a false positive.
/// `None` means the monitor is on the recording adapter or absent (lock, mode switch, display sleep);
/// both cases must stay retryable.
fn monitor_on_other_adapter_snapshot(
    own_luid: u64,
    adapters: &[(u64, Vec<isize>)],
    monitor: isize,
) -> Option<usize> {
    adapters
        .iter()
        .enumerate()
        .find_map(|(index, (luid, monitors))| {
            (*luid != own_luid && monitors.contains(&monitor)).then_some(index)
        })
}

/// Confirms that the game monitor is now driven by a different DXGI adapter. Only a positive LUID
/// match is reported; failed or transient enumeration is treated as "not confirmed" so DDA retries.
fn monitor_on_other_adapter(gpu: &Gpu, monitor: HMONITOR) -> Option<usize> {
    let monitor = monitor.0 as isize;
    let dxgi: IDXGIDevice = gpu.device.cast().ok()?;
    // SAFETY: dxgi is the shared device's DXGI interface; only its adapter is queried.
    let own_adapter = unsafe { dxgi.GetAdapter() }.ok()?;
    // SAFETY: own_adapter is the adapter that created the shared device; GetDesc only reads it.
    let own_desc = unsafe { own_adapter.GetDesc() }.ok()?;
    let own_luid = luid_key(own_desc.AdapterLuid.HighPart, own_desc.AdapterLuid.LowPart);
    // SAFETY: Creating a DXGI factory has no additional preconditions.
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    let mut adapters = Vec::new();
    for index in 0.. {
        // SAFETY: Enumerate in order; an out-of-range index returns DXGI_ERROR_NOT_FOUND.
        match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => {
                let adapter: IDXGIAdapter = adapter.cast().ok()?;
                // SAFETY: adapter was just enumerated; GetDesc only reads its description.
                let desc = unsafe { adapter.GetDesc() }.ok()?;
                let luid = luid_key(desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart);
                let monitors: Vec<isize> = output_monitors(&adapter)
                    .ok()?
                    .into_iter()
                    .map(|(_, monitor)| monitor)
                    .collect();
                adapters.push((luid, monitors));
            }
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            // A transient enumeration failure must not be mistaken for a confirmed cross-adapter move.
            Err(_) => return None,
        }
    }
    monitor_on_other_adapter_snapshot(own_luid, &adapters, monitor)
}

/// Enumerates all adapter outputs and their HMONITOR values (outputs not connected to the desktop have HMONITOR 0).
fn output_monitors(adapter: &IDXGIAdapter) -> Result<Vec<(IDXGIOutput, isize)>> {
    let mut outputs = Vec::new();
    for index in 0.. {
        // SAFETY: Enumerate in order; an out-of-range index returns DXGI_ERROR_NOT_FOUND.
        match unsafe { adapter.EnumOutputs(index) } {
            Ok(output) => {
                // SAFETY: output is a valid COM object just enumerated.
                let desc =
                    unsafe { output.GetDesc() }.context("capture_failed: Failed to read output information")?;
                outputs.push((output, desc.Monitor.0 as isize));
            }
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => {
                return Err(error).context("capture_failed: Failed to enumerate display outputs")
            }
        }
    }
    Ok(outputs)
}

fn monitor_of(hwnd: HWND) -> HMONITOR {
    // SAFETY: HWND is used only for queries; if the window disappears, PID remains zero and no process handle is acquired.
    unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) }
}

fn qpc_frequency() -> i64 {
    let mut freq = 0i64;
    // SAFETY: Writes only to the provided i64; this has not failed since Windows XP.
    unsafe {
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    freq.max(1)
}

/// Frame timestamp in 100 ns ticks relative to origin. If no desktop image changed, returns None; stale or invalid QPC timestamps use the current time.
/// The desktop image did not change, so returns None. A zero, future, or stale QPC timestamp uses the current time,
/// including the first frame from a static desktop after duplication starts, to avoid desynchronized audio/video.
/// to prevent the first timestamp from being seconds old and desynchronizing audio and video.
fn frame_pts(last_present: i64, accumulated: u32, now: i64, freq: i64, origin: i64) -> Option<i64> {
    if accumulated == 0 {
        return None;
    }
    let present = clock::qpc_to_ticks(last_present, freq);
    let ticks = if last_present != 0 && present <= now && now - present <= MAX_PRESENT_AGE {
        present
    } else {
        now
    };
    Some(ticks - origin)
}

/// DDA frame selection and timestamp alignment.
///
/// WGC spaces incoming frames at least one frame apart, while DDA follows monitor refreshes closely. Round frame selection and align PTS to prevent collisions.
/// timestamps advance in 4.17 ms steps). If using `FrameGate`（which floors time buckets），adjacent frames may be less than
/// one frame apart and be dropped by the encoder rule that rounds to 1/fps frames and drops duplicates (167 frames dropped in a 20-second 4K test).
/// Use the encoder rounded frame selection and align PTS to frame boundaries (error ≤ half a frame),
/// so frame indices remain integers and cannot collide regardless of the starting frame.
struct SlotGate {
    fps: i128,
    origin: Option<i64>,
    last: Option<i64>,
}

impl SlotGate {
    fn new(fps: u32) -> Self {
        Self {
            fps: fps.max(1) as i128,
            origin: None,
            last: None,
        }
    }

    /// Peek at the next frame without consuming it, so a static desktop can check the foreground before deciding whether to add a black frame.
    fn candidate(&mut self, pts: i64) -> Option<(i64, i64)> {
        if pts < 0 {
            return None;
        }
        let origin = *self.origin.get_or_insert(pts);
        let offset = pts.checked_sub(origin).filter(|offset| *offset >= 0)?;
        let ticks = clock::TICKS_PER_SEC as i128;
        let slot = ((offset as i128 * self.fps + ticks / 2) / ticks) as i64;
        if self.last.is_some_and(|last| slot <= last) {
            return None;
        }
        Some((slot, origin + (slot as i128 * ticks / self.fps) as i64))
    }

    /// Returns aligned PTS, or None if this frame was already sent or time moved backwards.
    fn accept(&mut self, pts: i64) -> Option<i64> {
        let (slot, pts) = self.candidate(pts)?;
        self.last = Some(slot);
        Some(pts)
    }
}

/// Queries only the window manager and never opens the target process; a failed query or missing foreground window is treated as hidden.
pub(super) fn foreground_state() -> (Option<u32>, bool) {
    // SAFETY: HWND is used only for queries; if the window disappears, PID remains zero and no process handle is acquired.
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        ((pid != 0).then_some(pid), IsIconic(hwnd).as_bool())
    }
}

fn game_visible(pid: u32, foreground_pid: Option<u32>, iconic: bool) -> bool {
    foreground_pid == Some(pid) && !iconic
}

/// Query at most once per output interval; also poll static desktops to switch to black frames when no new DDA frame arrives.
pub(super) struct Visibility {
    checked: Option<i64>,
    visible: bool,
}

impl Visibility {
    pub(super) fn new() -> Self {
        Self {
            checked: None,
            visible: true,
        }
    }

    pub(super) fn update(
        &mut self,
        pid: u32,
        pts: i64,
        query: impl FnOnce() -> (Option<u32>, bool),
    ) -> Option<CaptureNotice> {
        if self.checked.is_some_and(|last| pts <= last) {
            return None;
        }
        self.checked = Some(pts);
        let (foreground_pid, iconic) = query();
        let visible = game_visible(pid, foreground_pid, iconic);
        if visible == self.visible {
            return None;
        }
        self.visible = visible;
        Some(if visible {
            CaptureNotice::GameVisible { pts }
        } else {
            CaptureNotice::GameHidden { pts }
        })
    }

    pub(super) fn is_visible(&self) -> bool {
        self.visible
    }
}

/// Allocates only at initialization or size changes, clears to opaque black, then reuses the texture without reading back to the CPU.
pub(super) struct BlackFrame {
    texture: ID3D11Texture2D,
    size: (u32, u32),
}

impl BlackFrame {
    pub(super) fn new(gpu: &Gpu, size: (u32, u32)) -> Result<Self> {
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
        let mut view = None;
        // SAFETY: Same-device, single-mip, single-sample BGRA texture; clearing writes only to this owned resource.
        let texture = unsafe {
            gpu.device
                .CreateTexture2D(&desc, None, Some(&mut texture))?;
            let texture = texture.context("capture_failed: Missing DDA black-frame texture")?;
            gpu.device
                .CreateRenderTargetView(&texture, None, Some(&mut view))?;
            let view = view.context("capture_failed: Missing DDA black-frame render target")?;
            gpu.context
                .ClearRenderTargetView(&view, &[0.0, 0.0, 0.0, 1.0]);
            texture
        };
        Ok(Self { texture, size })
    }

    pub(super) fn deliver(&self, consumer: &mut dyn FrameConsumer, pts: i64) {
        consumer.on_frame(&CapturedFrame {
            texture: &self.texture,
            width: self.size.0,
            height: self.size.1,
            pts,
        });
    }
}

/// New desktop frames and timeout-generated black frames share the interval and foreground cache to avoid duplicate queries or output in one slot.
struct Output {
    pid: u32,
    gate: SlotGate,
    visibility: Visibility,
    black: BlackFrame,
    color: super::color::SdrConverter,
    cursor: Option<super::cursor::CursorOverlay>,
    cursor_visible: bool,
    monitor: HMONITOR,
    notices: Sender<CaptureNotice>,
}

impl Output {
    fn visible(&mut self, pts: i64) -> bool {
        // AcquireNextFrame has returned; no GPU or consumer lock is held here.
        if let Some(notice) = self.visibility.update(self.pid, pts, foreground_state) {
            let _ = self.notices.send(notice);
        }
        self.visibility.visible
    }

    fn idle(&mut self, consumer: &mut dyn FrameConsumer, now: i64) {
        if let Some((_, pts)) = self.gate.candidate(now) {
            if !self.visible(pts) {
                if let Some(pts) = self.gate.accept(now) {
                    self.black.deliver(consumer, pts);
                }
            }
        }
    }
}

/// Sleep for half the target frame interval when no new frame arrives, clamped to 1–8 ms; polling latency does not affect PTS.
/// Polling latency does not affect PTS.
fn poll_interval(max_fps: u32) -> Duration {
    (Duration::from_secs(1) / (2 * max_fps.max(1))).clamp(POLL_MIN, POLL_MAX)
}

/// DDA provides images in the panel native orientation for rotated displays (rotation is not handled yet).
fn rotation_unhandled(rotation: DXGI_MODE_ROTATION) -> bool {
    rotation != DXGI_MODE_ROTATION_IDENTITY && rotation != DXGI_MODE_ROTATION_UNSPECIFIED
}

#[derive(Debug, PartialEq, Eq)]
enum AcquireError {
    /// Duplication is invalid and must be recreated.
    Lost,
    /// The device was removed; the entire recording job must stop.
    DeviceLost(HRESULT),
    /// Other errors also trigger recreation, with the reason logged.
    Failed(HRESULT),
}

fn classify(code: HRESULT) -> Option<AcquireError> {
    if code == DXGI_ERROR_WAIT_TIMEOUT {
        None
    } else if code == DXGI_ERROR_DEVICE_REMOVED || code == DXGI_ERROR_DEVICE_RESET {
        Some(AcquireError::DeviceLost(code))
    } else if code == DXGI_ERROR_ACCESS_LOST {
        Some(AcquireError::Lost)
    } else {
        Some(AcquireError::Failed(code))
    }
}

fn check_device(gpu: &Gpu) -> Result<()> {
    // SAFETY: Only checks whether the shared device was removed; does not modify the device or context.
    unsafe { gpu.device.GetDeviceRemovedReason() }.context("capture_failed: D3D11 device was removed")
}

struct Duplication {
    dup: IDXGIOutputDuplication,
    size: (u32, u32),
}

/// Acquired DDA frame; calls ReleaseFrame when it leaves scope.
struct Acquired<'a> {
    dup: &'a IDXGIOutputDuplication,
    info: DXGI_OUTDUPL_FRAME_INFO,
    resource: Option<IDXGIResource>,
}

impl Drop for Acquired<'_> {
    fn drop(&mut self) {
        // SAFETY: Created only after AcquireNextFrame succeeds and paired with that acquisition exactly once.
        let _ = unsafe { self.dup.ReleaseFrame() };
    }
}

impl Duplication {
    /// Finds the monitor output on the GPU adapter and creates duplication.
    fn open(gpu: &Gpu, monitor: HMONITOR) -> Result<Self> {
        let dxgi: IDXGIDevice = gpu.device.cast()?;
        // SAFETY: DXGI interface from the shared device; reads only its adapter.
        let adapter = unsafe { dxgi.GetAdapter() }.context("capture_failed: Failed to get adapter")?;
        let Some((output, _)) = output_monitors(&adapter)?
            .into_iter()
            .find(|(_, m)| *m == monitor.0 as isize)
        else {
            bail!(
                "capture_failed: The game monitor is not driven by the recording adapter; DDA cannot capture it (use window capture)"
            );
        };
        let dup = duplicate(&output, gpu)?;
        // SAFETY: dup was just created and is valid.
        let desc = unsafe { dup.GetDesc() };
        if desc.DesktopImageInSystemMemory.as_bool() {
            bail!(
                "capture_failed: This display driver stores desktop images in system memory, which DDA does not support (use window capture)"
            );
        }
        if rotation_unhandled(desc.Rotation) {
            eprintln!(
                "DDA: The display is rotated ({}); the recording will keep the panel's native orientation",
                desc.Rotation.0
            );
        }
        Ok(Self {
            dup,
            size: (desc.ModeDesc.Width, desc.ModeDesc.Height),
        })
    }

    /// Waits for the next frame; timeout returns Ok(None).
    fn next(&self, timeout_ms: u32) -> Result<Option<Acquired<'_>>, AcquireError> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;
        // SAFETY: Output pointers reference local variables; the Acquired guard pairs success with ReleaseFrame.
        match unsafe {
            self.dup
                .AcquireNextFrame(timeout_ms, &mut info, &mut resource)
        } {
            Ok(()) => Ok(Some(Acquired {
                dup: &self.dup,
                info,
                resource,
            })),
            Err(error) => match classify(error.code()) {
                None => Ok(None),
                Some(error) => Err(error),
            },
        }
    }
}

fn duplicate(output: &IDXGIOutput, gpu: &Gpu) -> Result<IDXGIOutputDuplication> {
    // Preserve HDR values until our SDR tone mapping; SDR desktops remain BGRA.
    if let Ok(output5) = output.cast::<IDXGIOutput5>() {
        // SAFETY: The device belongs to this output adapter; the format array remains valid for the call.
        match unsafe {
            output5.DuplicateOutput1(
                &gpu.device,
                0,
                &[DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_B8G8R8A8_UNORM],
            )
        } {
            Ok(dup) => return Ok(dup),
            Err(error) => {
                eprintln!("DDA: DuplicateOutput1 failed ({error}); falling back to DuplicateOutput")
            }
        }
    }
    let output1: IDXGIOutput1 = output
        .cast()
        .context("capture_failed: Desktop Duplication is not supported by the system")?;
    // SAFETY: The device belongs to this output adapter.
    unsafe { output1.DuplicateOutput(&gpu.device) }
        .context("capture_failed: Failed to create Desktop Duplication")
}

/// Capture tracking state: the current window, monitor, and duplication.
struct Tracker {
    pid: u32,
    hwnd: Option<HWND>,
    monitor: HMONITOR,
    dup: Option<Duplication>,
    /// Most recently announced dimensions; None means a notification is required after the next successful creation.
    announced: Option<(u32, u32)>,
    retry_at: Instant,
    /// When this interruption began while recreation was failing.
    failing_since: Option<Instant>,
    lost_reported: bool,
    notices: Sender<CaptureNotice>,
}

impl Tracker {
    fn announce(&mut self, size: (u32, u32)) {
        if self.announced != Some(size) {
            self.announced = Some(size);
            let _ = self.notices.send(CaptureNotice::WindowFound {
                width: size.0,
                height: size.1,
                monitor: true,
            });
        }
    }

    fn lose_window(&mut self) {
        self.hwnd = None;
        self.dup = None;
        self.announced = None;
        self.failing_since = None;
        if !self.lost_reported {
            self.lost_reported = true;
            let _ = self.notices.send(CaptureNotice::WindowLost);
        }
    }

    /// Once per second, checks whether the window disappeared, reappeared, or moved to another monitor.
    fn check_window(&mut self) {
        match self.hwnd {
            Some(hwnd) if !window_matches(hwnd, self.pid) => self.lose_window(),
            Some(hwnd) => {
                let monitor = monitor_of(hwnd);
                if monitor != self.monitor {
                    // The game moved to another monitor: recreate capture there (the size may differ, so always notify again).
                    self.monitor = monitor;
                    self.dup = None;
                    self.announced = None;
                    self.retry_at = Instant::now();
                }
            }
            None => {
                if let Ok(hwnd) = find_window(self.pid) {
                    self.hwnd = Some(hwnd);
                    self.monitor = monitor_of(hwnd);
                    self.announced = None;
                    self.retry_at = Instant::now();
                }
            }
        }
    }

    /// Recreates duplication at the configured interval after it becomes invalid.
    fn reopen(&mut self, gpu: &Gpu) -> Result<()> {
        if self.hwnd.is_none() || Instant::now() < self.retry_at {
            return Ok(());
        }
        check_device(gpu)?;
        match Duplication::open(gpu, self.monitor) {
            Ok(dup) => {
                let size = dup.size;
                self.dup = Some(dup);
                self.failing_since = None;
                self.lost_reported = false;
                self.announce(size);
            }
            Err(error) => {
                check_device(gpu)?;
                if let Some(adapter) = monitor_on_other_adapter(gpu, self.monitor) {
                    // DDA cannot duplicate an output owned by another adapter; rebuilding the whole GPU
                    // pipeline is out of scope, so stop cleanly instead of retrying forever.
                    bail!(
                        "capture_failed: The game window moved to a monitor driven by a different graphics adapter (adapter {adapter}); DDA cannot continue on the original adapter. Restart with window capture to record across adapters. ({error:#})"
                    );
                }
                let since = *self.failing_since.get_or_insert_with(|| {
                    eprintln!("DDA recreation failed; continuing to retry: {error:#}");
                    Instant::now()
                });
                if since.elapsed() >= LOST_AFTER && !self.lost_reported {
                    self.lost_reported = true;
                    self.announced = None;
                    let _ = self.notices.send(CaptureNotice::WindowLost);
                }
                self.retry_at = Instant::now() + RETRY_INTERVAL;
            }
        }
        Ok(())
    }
}

fn pointer_visible(previous: bool, info: &DXGI_OUTDUPL_FRAME_INFO) -> bool {
    if info.LastMouseUpdateTime != 0 {
        info.PointerPosition.Visible.as_bool()
    } else {
        previous
    }
}

/// Passes the acquired frame to the consumer; returns `Err` if the frame format does not match (logged only once).
fn deliver(
    frame: &Acquired<'_>,
    consumer: &mut dyn FrameConsumer,
    output: &mut Output,
    freq: i64,
    origin: i64,
) -> Result<Option<(u32, u32)>> {
    // Pointer metadata is valid only on mouse updates; keep it even when the frame is throttled.
    output.cursor_visible = pointer_visible(output.cursor_visible, &frame.info);
    let Some(pts) = frame_pts(
        if output.cursor.is_some() && frame.info.AccumulatedFrames == 0 {
            0
        } else {
            frame.info.LastPresentTime
        },
        frame
            .info
            .AccumulatedFrames
            .max(u32::from(output.cursor.is_some())),
        clock::now_ticks(),
        freq,
        origin,
    ) else {
        return Ok(None);
    };
    let Some(resource) = &frame.resource else {
        return Ok(None);
    };
    let Some(pts) = output.gate.accept(pts) else {
        return Ok(None);
    };
    let texture: ID3D11Texture2D = resource
        .cast()
        .context("DDA frame is not a D3D11 texture")?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: texture remains valid while the Acquired guard lives; desc is writable.
    unsafe { texture.GetDesc(&mut desc) };
    if ![DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT].contains(&desc.Format)
        || desc.SampleDesc.Count != 1
    {
        bail!(
            "DDA desktop image format {} is not BGRA/scRGB; skipping",
            desc.Format.0
        );
    }
    if output.visible(pts) {
        let texture = output.color.convert(&texture, output.monitor)?;
        let texture = if output.cursor_visible {
            if let Some(cursor) = &mut output.cursor {
                match cursor.draw(&texture, output.monitor) {
                    Ok(texture) => texture,
                    Err(error) => {
                        eprintln!(
                            "Could not draw cursor; continuing without cursor overlay: {error:#}"
                        );
                        output.cursor = None;
                        texture
                    }
                }
            } else {
                texture
            }
        } else {
            texture
        };
        consumer.on_frame(&CapturedFrame {
            texture: &texture,
            width: desc.Width,
            height: desc.Height,
            pts,
        });
    } else {
        output.black.deliver(consumer, pts);
    }
    Ok(Some((desc.Width, desc.Height)))
}

pub(super) fn run(
    gpu: Gpu,
    opts: CaptureOptions,
    mut consumer: Box<dyn FrameConsumer>,
    notices: Sender<CaptureNotice>,
    stopped: Receiver<()>,
    ready: &mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    // SAFETY: Only sets this capture thread DPI mode; DuplicateOutput1 requires per-monitor DPI awareness.
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let freq = qpc_frequency();
    let hwnd = find_window(opts.pid)?;
    let monitor = monitor_of(hwnd);
    let dup = Duplication::open(&gpu, monitor)
        .context("capture_failed: Failed to initialize DDA capture")?;
    let mut output = Output {
        pid: opts.pid,
        gate: SlotGate::new(opts.max_fps),
        visibility: Visibility::new(),
        color: super::color::SdrConverter::new(&gpu)?,
        cursor: opts
            .capture_cursor
            .then(|| super::cursor::CursorOverlay::new(&gpu)),
        cursor_visible: false,
        monitor,
        black: BlackFrame::new(&gpu, dup.size)
            .context("capture_failed: Failed to create DDA black frame")?,
        notices: notices.clone(),
    };
    let mut tracker = Tracker {
        pid: opts.pid,
        hwnd: Some(hwnd),
        monitor,
        dup: None,
        announced: None,
        retry_at: Instant::now(),
        failing_since: None,
        lost_reported: false,
        notices,
    };
    tracker.announce(dup.size);
    tracker.dup = Some(dup);
    let _ = ready.send(Ok(()));
    let poll = poll_interval(opts.max_fps);
    let mut format_warned = false;
    let mut next_check = Instant::now() + WINDOW_CHECK;
    loop {
        match stopped.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if Instant::now() >= next_check {
            next_check = Instant::now() + WINDOW_CHECK;
            tracker.check_window();
            output.monitor = tracker.monitor;
        }
        if tracker.dup.is_none() {
            output.cursor_visible = false;
            tracker.reopen(&gpu)?;
        }
        if let Some(dup) = &tracker.dup {
            if output.black.size != dup.size {
                output.black = BlackFrame::new(&gpu, dup.size)
                    .context("capture_failed: Failed to resize DDA black frame")?;
            }
        }
        let Some(dup) = &tracker.dup else {
            output.idle(consumer.as_mut(), clock::now_ticks() - opts.origin_ticks);
            match stopped.recv_timeout(poll) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
            }
        };
        // Process the frame within the borrowed duplication scope (frame drop -> ReleaseFrame), then update state.
        let outcome = match dup.next(0) {
            Ok(None) => Ok(None),
            Ok(Some(frame)) => Ok(
                match deliver(
                    &frame,
                    consumer.as_mut(),
                    &mut output,
                    freq,
                    opts.origin_ticks,
                ) {
                    Ok(size) => size,
                    Err(error) => {
                        if !format_warned {
                            format_warned = true;
                            eprintln!("{error:#}");
                        }
                        None
                    }
                },
            ),
            Err(error) => Err(error),
        };
        match outcome {
            Ok(Some(size)) => tracker.announce(size),
            Ok(None) => {
                output.idle(consumer.as_mut(), clock::now_ticks() - opts.origin_ticks);
                thread::sleep(poll);
            }
            Err(AcquireError::Lost) => {
                check_device(&gpu)?;
                tracker.dup = None;
                tracker.retry_at = Instant::now();
            }
            Err(AcquireError::Failed(code)) => {
                check_device(&gpu)?;
                eprintln!("DDA frame acquisition failed ({code}); recreating capture");
                tracker.dup = None;
                tracker.retry_at = Instant::now() + RETRY_INTERVAL;
            }
            Err(AcquireError::DeviceLost(code)) => {
                check_device(&gpu)?;
                bail!("capture_failed: DDA device was removed ({code})");
            }
        }
    }
    // Release duplication before releasing the consumer.
    drop(tracker);
    drop(consumer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_visibility_survives_desktop_only_and_throttled_mouse_updates() {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        info.LastMouseUpdateTime = 1;
        info.PointerPosition.Visible = true.into();
        let mut visible = pointer_visible(false, &info);
        assert!(visible);
        info.LastMouseUpdateTime = 0;
        info.PointerPosition.Visible = false.into();
        visible = pointer_visible(visible, &info);
        assert!(visible);

        let mut gate = SlotGate::new(60);
        assert!(gate.accept(0).is_some());
        info.LastMouseUpdateTime = 2;
        visible = pointer_visible(visible, &info);
        assert!(gate.accept(1).is_none());
        assert!(!visible);
        info.LastMouseUpdateTime = 0;
        info.PointerPosition.Visible = true.into();
        assert!(!pointer_visible(visible, &info));
    }
    use crate::clock::TICKS_PER_SEC;
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_MODE_ROTATION_ROTATE180, DXGI_MODE_ROTATION_ROTATE270, DXGI_MODE_ROTATION_ROTATE90,
    };
    use windows::Win32::Graphics::Dxgi::DXGI_ERROR_INVALID_CALL;

    #[test]
    fn visibility_requires_target_foreground_pid_and_non_iconic_window() {
        for (foreground, iconic, expected) in [
            (Some(42), false, true),
            (Some(42), true, false),
            (Some(7), false, false),
            (Some(7), true, false),
            (None, false, false),
            (None, true, false),
        ] {
            assert_eq!(game_visible(42, foreground, iconic), expected);
        }
    }

    #[test]
    fn visibility_queries_once_per_slot_and_reports_only_transitions() {
        let mut visibility = Visibility::new();
        let mut gate = SlotGate::new(60);
        let mut queries = 0;
        for (pts, foreground, iconic, expected) in [
            (0, Some(42), false, None),
            (
                166_667,
                Some(7),
                false,
                Some(CaptureNotice::GameHidden { pts: 166_666 }),
            ),
            (333_334, None, false, None),
            (500_000, Some(42), true, None),
            (
                666_667,
                Some(42),
                false,
                Some(CaptureNotice::GameVisible { pts: 666_666 }),
            ),
        ] {
            let (_, pts) = gate.candidate(pts).unwrap();
            assert_eq!(
                visibility.update(42, pts, || {
                    queries += 1;
                    (foreground, iconic)
                }),
                expected
            );
            assert_eq!(visibility.update(42, pts, || panic!("duplicate query in the same slot")), None);
        }
        assert_eq!(queries, 5);
        let mut initially_hidden = Visibility::new();
        assert_eq!(
            initially_hidden.update(42, 0, || (None, false)),
            Some(CaptureNotice::GameHidden { pts: 0 })
        );
    }

    #[test]
    fn hidden_frames_advance_without_desktop_updates_and_share_output_slots() {
        let mut visibility = Visibility::new();
        let mut gate = SlotGate::new(60);
        assert_eq!(gate.accept(0), Some(0));
        let mut output = Vec::new();
        for now in (0..=TICKS_PER_SEC).step_by(10_000) {
            if let Some((_, pts)) = gate.candidate(now) {
                visibility.update(42, pts, || (None, false));
                if !visibility.visible {
                    if let Some(pts) = gate.accept(now) {
                        output.push(pts);
                    }
                }
            }
        }
        assert_eq!(output.len(), 60);
        assert_eq!(output[0], TICKS_PER_SEC / 60);
        assert_eq!(output.last(), Some(&TICKS_PER_SEC));
        assert_eq!(encoder_drops(&output, 60), 0);
        assert_eq!(gate.accept(TICKS_PER_SEC), None);
    }

    #[test]
    fn gpu_idle_black_frames_reach_small_frames_without_desktop_updates() {
        use crate::capture::small::{SmallFrameExtractor, SmallFrames};
        use crate::types::FramesSpec;

        struct Consumer {
            extractor: SmallFrameExtractor,
            frames: Vec<SmallFrames>,
            captured: Vec<(i64, u32, u32)>,
        }
        impl FrameConsumer for Consumer {
            fn on_frame(&mut self, frame: &CapturedFrame<'_>) {
                self.captured.push((frame.pts, frame.width, frame.height));
                if let Some(small) =
                    self.extractor
                        .on_frame(frame.texture, frame.width, frame.height, frame.pts)
                {
                    self.frames.push(small);
                }
            }
        }
        let gpu = Gpu::create().unwrap();
        for size in [(960, 540), (1920, 1080)] {
            let (notices, received) = mpsc::channel();
            let mut output = Output {
                pid: u32::MAX,
                gate: SlotGate::new(60),
                visibility: Visibility::new(),
                color: crate::capture::color::SdrConverter::new(&gpu).unwrap(),
                cursor: None,
                cursor_visible: false,
                monitor: HMONITOR::default(),
                black: BlackFrame::new(&gpu, size).unwrap(),
                notices,
            };
            let mut consumer = Consumer {
                extractor: SmallFrameExtractor::new(
                    &gpu,
                    FramesSpec {
                        banner: [0, 0, 96, 48],
                        spec: [960, 540, 96, 48],
                        base: [1920, 1080],
                    },
                )
                .unwrap(),
                frames: Vec::new(),
                captured: Vec::new(),
            };
            for slot in 0..4 {
                let pts = slot * TICKS_PER_SEC / 4;
                output.idle(&mut consumer, pts);
                output.idle(&mut consumer, pts + 1);
                // SAFETY: Submits only commands to the test device so asynchronous thumbnail readback completes before the next sample.
                unsafe { gpu.context.Flush() };
                thread::sleep(Duration::from_millis(100));
            }
            assert_eq!(consumer.captured.len(), 4);
            assert!(consumer.captured.iter().all(|f| (f.1, f.2) == size));
            assert_eq!(
                received.try_iter().collect::<Vec<_>>(),
                vec![CaptureNotice::GameHidden { pts: 0 }]
            );
            assert_eq!(consumer.frames.len(), 3);
            assert!(consumer.frames[0].thumb.is_some());
            for (slot, small) in consumer.frames.iter().enumerate() {
                assert_eq!(small.pts, slot as i64 * TICKS_PER_SEC / 4);
                assert!(small
                    .banner
                    .iter()
                    .chain(&small.spec)
                    .chain(small.thumb.iter().flatten())
                    .all(|&v| v == 0));
            }
        }
    }

    #[test]
    fn cross_adapter_requires_a_positive_luid_match_on_another_adapter() {
        let snapshot = [(1, vec![0x10]), (2, vec![0x20]), (3, vec![])];
        assert_eq!(monitor_on_other_adapter_snapshot(1, &snapshot, 0x20), Some(1));
        assert_eq!(
            monitor_on_other_adapter_snapshot(1, &snapshot, 0x10),
            None,
            "the monitor is still driven by the recording adapter"
        );
        assert_eq!(
            monitor_on_other_adapter_snapshot(1, &snapshot, 0x99),
            None,
            "a monitor that is temporarily absent must stay retryable"
        );
        assert_eq!(
            monitor_on_other_adapter_snapshot(1, &[(2, vec![0x10])], 0x10),
            Some(0),
            "a same-numbered monitor on a different adapter is a confirmed move"
        );
        assert_eq!(
            monitor_on_other_adapter_snapshot(1, &[(1, vec![]), (2, vec![])], 0x99),
            None
        );
    }

    #[test]
    fn locate_finds_adapter_and_output_owning_the_monitor() {
        let adapters = vec![vec![], vec![0x10, 0x20], vec![0x30]];
        assert_eq!(locate(&adapters, 0x20), Some((1, 1)));
        assert_eq!(locate(&adapters, 0x30), Some((2, 0)));
        assert_eq!(locate(&adapters, 0x40), None);
        assert_eq!(locate(&[], 0x10), None);
        // On duplicates, take the first in enumeration order (default adapter first).
        assert_eq!(locate(&[vec![0x10], vec![0x10]], 0x10), Some((0, 0)));
    }

    #[test]
    fn frame_pts_prefers_present_time_and_skips_pointer_only_updates() {
        let freq = 10_000_000;
        assert_eq!(frame_pts(5_000, 1, 9_999, freq, 1_000), Some(4_000));
        // Cursor-only movement: no new desktop image.
        assert_eq!(frame_pts(5_000, 0, 9_999, freq, 1_000), None);
        // Use the current time when LastPresentTime is 0.
        assert_eq!(frame_pts(0, 2, 9_999, freq, 1_000), Some(8_999));
        // Convert QPC frequencies other than 10 MHz to 100 ns ticks.
        assert_eq!(
            frame_pts(3_000_000, 1, TICKS_PER_SEC + 10, 3_000_000, 0),
            Some(TICKS_PER_SEC)
        );
        // Use the current time for stale (first frame of a static desktop) or future present times.
        let now = 100 * TICKS_PER_SEC;
        assert_eq!(
            frame_pts(now - MAX_PRESENT_AGE, 1, now, freq, 0),
            Some(now - MAX_PRESENT_AGE)
        );
        assert_eq!(
            frame_pts(now - MAX_PRESENT_AGE - 1, 1, now, freq, 0),
            Some(now)
        );
        assert_eq!(frame_pts(now + 1, 1, now, freq, 0), Some(now));
    }

    /// Simulates the encoder frame-selection rule using the first received PTS as the origin,
    /// rounds to 1/fps frames, and drops frames when the index does not advance.
    fn encoder_drops(pts: &[i64], fps: i64) -> usize {
        let origin = pts[0];
        let mut last = None;
        let mut drops = 0;
        for &p in pts {
            let slot = ((p - origin) as i128 * fps as i128 + 5_000_000) / 10_000_000;
            if last.is_some_and(|l| slot <= l) {
                drops += 1;
            } else {
                last = Some(slot);
            }
        }
        drops
    }

    #[test]
    fn slot_gate_rounds_like_the_encoder_and_snaps_to_slot_times() {
        let mut gate = SlotGate::new(60);
        assert_eq!(gate.accept(-1), None);
        assert_eq!(gate.accept(1_000), Some(1_000));
        // Less than half a frame: same slot, drop.
        assert_eq!(gate.accept(1_000 + 83_333), None);
        // More than half a frame: next slot, aligned to a frame boundary (1/60 s = 166,666 ticks).
        assert_eq!(gate.accept(1_000 + 83_334), Some(1_000 + 166_666));
        assert_eq!(
            gate.accept(1_000 + 2 * 166_667 + 40_000),
            Some(1_000 + 333_333)
        );
        // Time moved backwards: drop.
        assert_eq!(gate.accept(500), None);
        assert_eq!(
            gate.accept(1_000 + 10 * TICKS_PER_SEC),
            Some(1_000 + 10 * TICKS_PER_SEC)
        );
    }

    #[test]
    fn slot_gate_output_never_collides_in_the_encoder_whatever_its_origin() {
        // A 240 Hz monitor with a window updating near 64 Hz; present times fall on 4.17 ms boundaries, reproducing dropped frames.
        let vsync = TICKS_PER_SEC / 240;
        let presents: Vec<i64> = (0..2_000)
            .map(|i| {
                let t = 7 * TICKS_PER_SEC + i * 156_250;
                (t + vsync - 1) / vsync * vsync
            })
            .collect();
        for fps in [30, 60, 120, 144] {
            let mut gate = SlotGate::new(fps);
            let out: Vec<i64> = presents.iter().filter_map(|&p| gate.accept(p)).collect();
            assert!(out.windows(2).all(|pair| pair[0] < pair[1]));
            for skip in [0, 1, 7, 33] {
                assert_eq!(
                    encoder_drops(&out[skip..], fps as i64),
                    0,
                    "fps {fps}, origin {skip}"
                );
            }
        }
        // Comparison: passing present times directly to the encoder rule causes frame-index collisions.
        assert!(encoder_drops(&presents, 60) > 0);
    }

    #[test]
    fn poll_interval_is_half_frame_clamped() {
        assert_eq!(poll_interval(60), Duration::from_millis(8));
        assert_eq!(poll_interval(144), Duration::from_nanos(3_472_222));
        assert_eq!(poll_interval(30), POLL_MAX);
        assert_eq!(poll_interval(10_000), POLL_MIN);
        assert_eq!(poll_interval(0), POLL_MAX);
    }

    #[test]
    fn classifies_acquire_results() {
        assert_eq!(classify(DXGI_ERROR_WAIT_TIMEOUT), None);
        assert_eq!(classify(DXGI_ERROR_ACCESS_LOST), Some(AcquireError::Lost));
        for code in [DXGI_ERROR_DEVICE_REMOVED, DXGI_ERROR_DEVICE_RESET] {
            assert_eq!(classify(code), Some(AcquireError::DeviceLost(code)));
        }
        assert_eq!(
            classify(DXGI_ERROR_INVALID_CALL),
            Some(AcquireError::Failed(DXGI_ERROR_INVALID_CALL))
        );
    }

    #[test]
    fn identity_is_the_only_handled_rotation() {
        assert!(!rotation_unhandled(DXGI_MODE_ROTATION_IDENTITY));
        assert!(!rotation_unhandled(DXGI_MODE_ROTATION_UNSPECIFIED));
        assert!(rotation_unhandled(DXGI_MODE_ROTATION_ROTATE90));
        assert!(rotation_unhandled(DXGI_MODE_ROTATION_ROTATE180));
        assert!(rotation_unhandled(DXGI_MODE_ROTATION_ROTATE270));
    }
}
