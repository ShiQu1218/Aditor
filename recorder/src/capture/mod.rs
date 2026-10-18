//! WGC 擷取（任務 B2）。依 PID 找 Apex 的頂層視窗建立 `GraphicsCaptureItem`；
//! 視窗重建時自動重接；連續 3 秒全黑改用 `CreateForMonitor`（規格 §3.1）。
//! 另一種擷取方式 DDA（整個螢幕、延遲較低）見 `dda`，由 `Capture::start_with` 選擇。
//!
//! 介面由骨架固定，實作者不得改動簽章；需要新增的型別放在本模組內。

pub mod dda;
pub mod small;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
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
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsWindow,
    IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

use crate::clock::TICKS_PER_SEC;
use crate::gpu::Gpu;
pub use crate::types::CaptureMethod;
use small::LumaProbe;

/// 一格擷取畫面。`texture` 只在 `on_frame` 呼叫期間有效（屬於 WGC frame pool 或 DDA 桌面影像），
/// 消費者若要保留必須在呼叫內以 GPU 複製（`CopyResource`／`CopySubresourceRegion`）。
pub struct CapturedFrame<'a> {
    pub texture: &'a ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
    /// 100 ns tick，session 起點為 0（見 `clock`）。
    pub pts: i64,
}

/// 在擷取執行緒上被呼叫；**不得阻塞**（只做 GPU 複製與丟進佇列）。
pub trait FrameConsumer: Send {
    fn on_frame(&mut self, frame: &CapturedFrame<'_>);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureNotice {
    WindowLost,
    WindowFound {
        width: u32,
        height: u32,
        monitor: bool,
    },
}

#[derive(Debug, Clone)]
pub struct CaptureOptions {
    pub pid: u32,
    /// 送給消費者的最高 fps（超過就丟格，依 pts 節流）。
    pub max_fps: u32,
    /// 第一格的 QPC tick（`clock::now_ticks()`）；pts = 該格系統時間 − origin。
    pub origin_ticks: i64,
}

pub struct Capture {
    stop: Sender<()>,
    worker: Option<JoinHandle<()>>,
}

impl Capture {
    /// 開始 WGC 擷取。找不到視窗時回傳錯誤（訊息含 `window_not_found`）。
    #[allow(dead_code)] // 整合測試以 #[path] 引入本檔；正式程式一律經 start_with。
    pub fn start(
        gpu: &Gpu,
        opts: CaptureOptions,
        consumer: Box<dyn FrameConsumer>,
        notices: Sender<CaptureNotice>,
    ) -> Result<Self> {
        Self::start_with(CaptureMethod::Wgc, gpu, opts, consumer, notices)
    }

    /// 以指定方式開始擷取。DDA 的 `gpu` 必須建立在擁有遊戲所在螢幕的轉接器上
    /// （見 `dda::gpu_for_pid`），否則回傳 `capture_failed`。
    pub fn start_with(
        method: CaptureMethod,
        gpu: &Gpu,
        opts: CaptureOptions,
        consumer: Box<dyn FrameConsumer>,
        notices: Sender<CaptureNotice>,
    ) -> Result<Self> {
        if opts.max_fps == 0 || opts.max_fps > TICKS_PER_SEC as u32 {
            bail!("capture_failed: max_fps 必須介於 1 與 10000000");
        }
        let gpu = gpu.clone();
        let (stop, stopped) = mpsc::channel();
        let (ready, initialized) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("apexrec-capture".into())
            .spawn(move || {
                let result = match method {
                    CaptureMethod::Wgc => run(gpu, opts, consumer, notices, stopped, &ready),
                    CaptureMethod::Dda => dda::run(gpu, opts, consumer, notices, stopped, &ready),
                };
                if let Err(error) = result {
                    // 初始化錯誤交回 start；執行中錯誤則寫入 stderr，不污染 IPC stdout。
                    let message = format!("{error:#}");
                    let _ = ready.send(Err(error));
                    eprintln!("擷取執行緒結束：{message}");
                }
            })
            .context("capture_failed: 無法建立擷取執行緒")?;
        let mut capture = Self {
            stop,
            worker: Some(worker),
        };
        match initialized
            .recv()
            .context("capture_failed: 擷取初始化中斷")?
        {
            Ok(()) => Ok(capture),
            Err(error) => {
                capture.shutdown();
                Err(error)
            }
        }
    }

    /// 停止擷取並等待擷取執行緒結束。
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                eprintln!("擷取執行緒非預期結束");
            }
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Apartment;

impl Apartment {
    fn new() -> Result<Self> {
        // SAFETY: 專屬新執行緒以 MTA 初始化，成功後由 Drop 在同執行緒配對解除。
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).context("capture_failed: 初始化 WinRT 失敗")?
        };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: 與本執行緒成功的 RoInitialize 一對一配對；WinRT 物件已先釋放。
        unsafe { RoUninitialize() };
    }
}

struct WindowSearch {
    pid: u32,
    best: Option<HWND>,
    area: i64,
}

unsafe extern "system" fn enum_window(hwnd: HWND, data: LPARAM) -> BOOL {
    // SAFETY: EnumWindows 同步呼叫；data 在整段列舉期間指向唯一可變的 WindowSearch。
    let search = unsafe { &mut *(data.0 as *mut WindowSearch) };
    let mut pid = 0;
    let mut rect = RECT::default();
    // SAFETY: 只查詢列舉提供的 HWND 與 PID，不開啟目標程序；輸出指標均有效。
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

fn find_window(pid: u32) -> Result<HWND> {
    let mut search = WindowSearch {
        pid,
        best: None,
        area: 0,
    };
    // SAFETY: 回呼同步執行且不保留 search 的指標；所有路徑都繼續列舉。
    unsafe {
        EnumWindows(
            Some(enum_window),
            LPARAM((&mut search as *mut WindowSearch) as isize),
        )
    }
    .context("capture_failed: 列舉視窗失敗")?;
    search
        .best
        .with_context(|| format!("window_not_found: 找不到 PID {pid} 的可見視窗"))
}

fn window_matches(hwnd: HWND, pid: u32) -> bool {
    let mut actual_pid = 0;
    // SAFETY: HWND 可能已失效，這些查詢會安全回報失敗；只讀取視窗資訊。
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut actual_pid));
        actual_pid == pid && IsWindow(Some(hwnd)).as_bool() && IsWindowVisible(hwnd).as_bool()
    }
}

/// 用 QPC 時間桶限制平均幀率，避免 60 Hz 時戳的微小抖動讓逐格間隔比較降成 30 fps。
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
        // 沒有畫面不算連續全黑；讀回中斷超過兩個 thumb 週期就重新計時。
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
    device: IDirect3DDevice,
    consumer: Box<dyn FrameConsumer>,
    gate: FrameGate,
    origin: i64,
    probe: LumaProbe,
    black: BlackStreak,
    notices: Sender<CaptureNotice>,
}

// SAFETY: device 是 D3D11 的 agile WinRT wrapper；probe 使用已開啟 multithread 保護的
// 共用裝置，consumer 保證 Send；所有狀態另以 Mutex 串行存取。
unsafe impl Send for CallbackState {}

struct Signals {
    alive: AtomicBool,
    closed: AtomicBool,
    fallback: AtomicBool,
    size: AtomicU64,
    dropped: AtomicU64,
}

fn pack_size(size: SizeInt32) -> u64 {
    (size.Width as u64) << 32 | size.Height as u32 as u64
}

struct ActiveCapture {
    hwnd: HWND,
    monitor: bool,
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    frame_token: Option<i64>,
    closed_token: Option<i64>,
    signals: Arc<Signals>,
}

impl ActiveCapture {
    fn new(
        hwnd: HWND,
        monitor: bool,
        opts: &CaptureOptions,
        shared: &Arc<Mutex<CallbackState>>,
    ) -> Result<Self> {
        let interop: IGraphicsCaptureItemInterop =
            factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        // SAFETY: HWND 來自本 PID 的可見頂層視窗；螢幕擷取使用其所在的有效 HMONITOR。
        let item: GraphicsCaptureItem = unsafe {
            if monitor {
                interop.CreateForMonitor(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST))?
            } else {
                interop.CreateForWindow(hwnd)?
            }
        };
        let size = item.Size()?;
        if size.Width <= 0 || size.Height <= 0 {
            bail!("capture_failed: 擷取目標尺寸無效");
        }
        let device = {
            let mut state = shared
                .lock()
                .map_err(|_| anyhow::anyhow!("capture_failed: 擷取狀態已損壞"))?;
            state.black = BlackStreak::default();
            state.probe.reset();
            state.device.clone()
        };
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        session.SetIsCursorCaptureEnabled(false)?;
        // 舊版 Windows 沒有這兩個介面；不支援時仍可擷取。
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetMinUpdateInterval(TimeSpan {
            Duration: TICKS_PER_SEC / opts.max_fps as i64,
        });
        let signals = Arc::new(Signals {
            alive: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            fallback: AtomicBool::new(false),
            size: AtomicU64::new(pack_size(size)),
            dropped: AtomicU64::new(0),
        });
        let mut active = Self {
            hwnd,
            monitor,
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
            // try_lock 不等待前一個回呼；pool 固定兩格，落後就丟格並計數。
            let Ok(mut state) = state.try_lock() else {
                signals.dropped.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            };
            if !signals.alive.load(Ordering::Acquire) {
                return Ok(());
            }
            if let Err(error) = state.frame(pool, monitor, &signals) {
                eprintln!("擷取回呼失敗：{error:#}");
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
        signals: &Signals,
    ) -> Result<()> {
        let frame = Frame(pool.TryGetNextFrame()?);
        let size = frame.0.ContentSize()?;
        if size.Width <= 0 || size.Height <= 0 {
            return Ok(());
        }
        let pts = frame.0.SystemRelativeTime()?.Duration - self.origin;
        let resized = signals.size.load(Ordering::Acquire) != pack_size(size);
        if self.gate.accept(pts) {
            let access: IDirect3DDxgiInterfaceAccess = frame.0.Surface()?.cast()?;
            // SAFETY: WGC Surface 實作 IDirect3DDxgiInterfaceAccess，取得同裝置的 D3D11 texture。
            let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            // SAFETY: texture 在 Frame guard 存活期間有效；desc 是可寫入的描述結構。
            unsafe { texture.GetDesc(&mut desc) };
            if desc.Width >= size.Width as u32 && desc.Height >= size.Height as u32 {
                self.consumer.on_frame(&CapturedFrame {
                    texture: &texture,
                    width: size.Width as u32,
                    height: size.Height as u32,
                    pts,
                });
                if !monitor {
                    if let Some((pts, black)) = self.probe.on_frame(
                        &texture,
                        (size.Width as u32, size.Height as u32),
                        pts,
                    )? {
                        if self.black.observe(pts, black) {
                            signals.fallback.store(true, Ordering::Release);
                        }
                    }
                }
            }
        } else {
            signals.dropped.fetch_add(1, Ordering::Relaxed);
        }
        // 必須先歸還舊 frame，才能重建 pool；放大時不把舊 texture 當成新尺寸傳給消費者。
        drop(frame);
        if resized {
            pool.Recreate(
                &self.device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                size,
            )?;
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
    // SAFETY: dxgi 是共用 D3D11 裝置，回傳 WinRT wrapper 保持相同的 GPU 裝置身分。
    let device = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
    let probe = LumaProbe::new(&gpu).context("capture_failed: 建立黑畫面探測器失敗")?;
    let shared = Arc::new(Mutex::new(CallbackState {
        device,
        consumer,
        gate: FrameGate::new(opts.max_fps),
        origin: opts.origin_ticks,
        probe,
        black: BlackStreak::default(),
        notices: notices.clone(),
    }));
    let mut active = Some(
        ActiveCapture::new(hwnd, false, &opts, &shared)
            .context("capture_failed: 建立 WGC 擷取失敗")?,
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
        if let Some(capture) = &active {
            if !capture.monitor && capture.signals.fallback.load(Ordering::Acquire) {
                let hwnd = capture.hwnd;
                drop(active.take());
                match ActiveCapture::new(hwnd, true, &opts, &shared) {
                    Ok(capture) => {
                        capture.announce(&notices);
                        active = Some(capture);
                    }
                    Err(error) => {
                        eprintln!("切換螢幕擷取失敗：{error:#}");
                        let _ = notices.send(CaptureNotice::WindowLost);
                    }
                }
            }
        }
        if Instant::now() < next_check {
            continue;
        }
        next_check = Instant::now() + Duration::from_secs(1);
        if active.as_ref().is_some_and(|capture| {
            capture.signals.closed.load(Ordering::Acquire)
                || !window_matches(capture.hwnd, opts.pid)
        }) {
            drop(active.take());
            let _ = notices.send(CaptureNotice::WindowLost);
        }
        if active.is_none() {
            if let Ok(hwnd) = find_window(opts.pid) {
                match ActiveCapture::new(hwnd, false, &opts, &shared) {
                    Ok(capture) => {
                        capture.announce(&notices);
                        active = Some(capture);
                    }
                    Err(error) => eprintln!("重建視窗擷取失敗：{error:#}"),
                }
            }
        } else if let Some(capture) = &active {
            // 無新 frame 時仍每秒查詢目標尺寸；重建由下一個 FrameArrived 歸還 frame 後執行。
            if let Ok(size) = capture.item.Size() {
                if size.Width <= 0 || size.Height <= 0 {
                    capture.signals.closed.store(true, Ordering::Release);
                }
            }
        }
    }
    // 先關回呼與 pool，再釋放消費者與 WinRT apartment。
    drop(active);
    // 關閉前已開始的回呼也必須完成；等待只發生在擷取管理執行緒，回呼仍使用 try_lock。
    drop(
        shared
            .lock()
            .map_err(|_| anyhow::anyhow!("capture_failed: 擷取狀態已損壞"))?,
    );
    drop(shared);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
