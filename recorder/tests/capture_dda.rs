//! 在真實 D3D11 裝置上驗證 DDA（Desktop Duplication）擷取：以本測試程序的置頂視窗代替遊戲，
//! 擷取它所在的整個螢幕；不開啟或操作遊戲程序。需要已登入、螢幕開啟的互動桌面。
#![allow(dead_code)]

#[path = "../src/capture/mod.rs"]
mod capture;
#[path = "../src/clock.rs"]
mod clock;
#[path = "../src/gpu.rs"]
mod gpu;
#[path = "../src/types.rs"]
mod types;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use capture::FrameConsumer;
use capture::{dda, Capture, CaptureMethod, CaptureNotice, CaptureOptions, CapturedFrame};
use clock::TICKS_PER_SEC;
use gpu::Gpu;
use windows::core::{w, Interface};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, DXGI_ERROR_NOT_FOUND,
};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::*;

static HARDWARE: Mutex<()> = Mutex::new(());
const WIDTH: i32 = 960;
const HEIGHT: i32 = 540;
/// 背景 COLORREF 0x00BBGGRR：藍；中央方塊：綠。
const BACKGROUND: u32 = 0xff0000;
const BLOCK: u32 = 0x00ff00;

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    // SAFETY: 所有訊息由此視窗的擁有執行緒處理，只畫自己的視窗。
    unsafe {
        match message {
            WM_TIMER => {
                let _ = InvalidateRect(Some(hwnd), None, false);
                LRESULT(0)
            }
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut paint);
                let mut rect = RECT::default();
                GetClientRect(hwnd, &mut rect).unwrap();
                fill(dc, rect, BACKGROUND);
                fill(
                    dc,
                    RECT {
                        left: rect.right / 2,
                        top: rect.bottom / 2,
                        right: rect.right * 3 / 5,
                        bottom: rect.bottom * 3 / 5,
                    },
                    BLOCK,
                );
                // 角落每格換色，讓桌面持續更新。
                static TICK: AtomicU32 = AtomicU32::new(0);
                fill(
                    dc,
                    RECT {
                        left: rect.right - 16,
                        top: rect.bottom - 16,
                        right: rect.right,
                        bottom: rect.bottom,
                    },
                    TICK.fetch_add(1, Ordering::Relaxed) % 256,
                );
                let _ = EndPaint(hwnd, &paint);
                let _ = GdiFlush();
                LRESULT(0)
            }
            WM_CLOSE => {
                DestroyWindow(hwnd).unwrap();
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wp, lp),
        }
    }
}

unsafe fn fill(dc: HDC, rect: RECT, color: u32) {
    // SAFETY: dc 在 BeginPaint/EndPaint 之間有效；brush 在 FillRect 後立即釋放。
    unsafe {
        let brush = CreateSolidBrush(COLORREF(color));
        assert_ne!(FillRect(dc, &rect, brush), 0);
        assert!(DeleteObject(brush.into()).as_bool());
    }
}

struct TestWindow {
    hwnd: usize,
    worker: Option<JoinHandle<()>>,
}

impl TestWindow {
    fn new() -> Self {
        let (ready, initialized) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            // SAFETY: 測試只設定自己的視窗執行緒 DPI 模式；HWND 與訊息迴圈留在同執行緒。
            unsafe {
                let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                let instance = HINSTANCE(GetModuleHandleW(None).unwrap().0);
                static CLASS: OnceLock<u16> = OnceLock::new();
                let atom = CLASS.get_or_init(|| {
                    RegisterClassW(&WNDCLASSW {
                        lpfnWndProc: Some(window_proc),
                        hInstance: instance,
                        lpszClassName: w!("ApexrecDdaTest"),
                        ..Default::default()
                    })
                });
                assert_ne!(*atom, 0);
                let hwnd = CreateWindowExW(
                    WS_EX_TOPMOST | WS_EX_NOACTIVATE,
                    w!("ApexrecDdaTest"),
                    w!("apexrec DDA 擷取測試"),
                    WS_POPUP | WS_VISIBLE,
                    40,
                    40,
                    WIDTH,
                    HEIGHT,
                    None,
                    None,
                    Some(instance),
                    None,
                )
                .unwrap();
                assert_ne!(SetTimer(Some(hwnd), 1, 16, None), 0);
                let _ = UpdateWindow(hwnd);
                ready.send(hwnd.0 as usize).unwrap();
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        });
        Self {
            hwnd: initialized.recv_timeout(Duration::from_secs(5)).unwrap(),
            worker: Some(worker),
        }
    }

    /// 綠色方塊中心在「所在螢幕」座標系中的位置，以及該螢幕的實體尺寸。
    fn block_center_on_monitor(&self) -> ((u32, u32), (u32, u32)) {
        // SAFETY: 本執行緒設為 per-monitor DPI aware，取得實體像素座標；HWND 在測試期間有效。
        unsafe {
            let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let hwnd = HWND(self.hwnd as *mut _);
            let mut rect = RECT::default();
            GetWindowRect(hwnd, &mut rect).unwrap();
            let mut info = MONITORINFO {
                cbSize: size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            assert!(
                GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info)
                    .as_bool()
            );
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            let x = rect.left + width * 11 / 20 - info.rcMonitor.left;
            let y = rect.top + height * 11 / 20 - info.rcMonitor.top;
            let monitor = (
                (info.rcMonitor.right - info.rcMonitor.left) as u32,
                (info.rcMonitor.bottom - info.rcMonitor.top) as u32,
            );
            ((x as u32, y as u32), monitor)
        }
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        // SAFETY: WM_CLOSE 由擁有此視窗的執行緒處理，join 後 HWND 不再使用。
        unsafe {
            let _ = PostMessageW(
                Some(HWND(self.hwnd as *mut _)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            );
        }
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

/// 記錄每格 pts／尺寸；`sample` 為 true 時在呼叫內讀回指定像素（測試才允許同步 Map）。
struct Consumer {
    gpu: Gpu,
    staging: ID3D11Texture2D,
    point: (u32, u32),
    sample: Arc<AtomicBool>,
    frames: Sender<(i64, u32, u32)>,
    pixels: Sender<[u8; 4]>,
}

impl FrameConsumer for Consumer {
    fn on_frame(&mut self, frame: &CapturedFrame<'_>) {
        let _ = self.frames.send((frame.pts, frame.width, frame.height));
        if !self.sample.swap(false, Ordering::AcqRel) {
            return;
        }
        let region = D3D11_BOX {
            left: self.point.0,
            top: self.point.1,
            front: 0,
            right: self.point.0 + 1,
            bottom: self.point.1 + 1,
            back: 1,
        };
        // SAFETY: 來源 texture 在本次呼叫期間有效；staging 為同裝置 1×1 BGRA，Map 後立即 Unmap。
        unsafe {
            self.gpu.context.CopySubresourceRegion(
                &self.staging,
                0,
                0,
                0,
                0,
                frame.texture,
                0,
                Some(&region),
            );
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.gpu
                .context
                .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .unwrap();
            let pixel = std::slice::from_raw_parts(mapped.pData as *const u8, 4);
            let _ = self.pixels.send([pixel[0], pixel[1], pixel[2], pixel[3]]);
            self.gpu.context.Unmap(&self.staging, 0);
        }
    }
}

fn staging(gpu: &Gpu) -> ID3D11Texture2D {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: 1,
        Height: 1,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        ..Default::default()
    };
    let mut texture = None;
    // SAFETY: 描述完整的 1×1 staging texture；輸出由 windows crate 管理。
    unsafe {
        gpu.device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .unwrap()
    };
    texture.unwrap()
}

fn notice_until(
    notices: &Receiver<CaptureNotice>,
    predicate: impl Fn(&CaptureNotice) -> bool,
) -> CaptureNotice {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let notice = notices
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        if predicate(&notice) {
            return notice;
        }
    }
}

#[test]
fn dda_captures_monitor_pixels_with_increasing_pts_and_reconnects() {
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    let window = TestWindow::new();
    let origin = clock::now_ticks();
    let (point, monitor) = window.block_center_on_monitor();
    let gpu = dda::gpu_for_pid(std::process::id()).unwrap();
    let (frames_tx, frames) = mpsc::channel();
    let (pixels_tx, pixels) = mpsc::channel();
    let (notices_tx, notices) = mpsc::channel();
    let sample = Arc::new(AtomicBool::new(false));
    let capture = Capture::start_with(
        CaptureMethod::Dda,
        &gpu,
        CaptureOptions {
            pid: std::process::id(),
            max_fps: 60,
            origin_ticks: origin,
        },
        Box::new(Consumer {
            gpu: gpu.clone(),
            staging: staging(&gpu),
            point,
            sample: sample.clone(),
            frames: frames_tx,
            pixels: pixels_tx,
        }),
        notices_tx,
    )
    .unwrap();
    assert_eq!(
        notice_until(&notices, |_| true),
        CaptureNotice::WindowFound {
            width: monitor.0,
            height: monitor.1,
            monitor: true
        }
    );
    thread::sleep(Duration::from_secs(2));
    let initial: Vec<_> = frames.try_iter().collect();
    eprintln!("DDA 兩秒收到 {} 格（螢幕 {monitor:?}）", initial.len());
    assert!(initial.len() >= 30, "兩秒只收到 {} 格", initial.len());
    // pts 與 QPC 同源：最後一格在「現在」之前不到半秒（對齊格點最多往後推半格）。
    let age = clock::now_ticks() - origin - initial.last().unwrap().0;
    assert!(
        (-TICKS_PER_SEC / 120..TICKS_PER_SEC / 2).contains(&age),
        "最後一格距今 {age} tick"
    );
    // pts 對齊到 1/60 s 格點：間隔是整數格（容許 1 tick 的整數除法誤差）。
    let slot = TICKS_PER_SEC as f64 / 60.0;
    for pair in initial.windows(2) {
        let slots = (pair[1].0 - pair[0].0) as f64 / slot;
        assert!(
            slots >= 0.99 && (slots - slots.round()).abs() * slot <= 1.5,
            "間隔 {slots} 格"
        );
    }
    assert!(initial.windows(2).all(|pair| pair[0].0 < pair[1].0));
    assert!(initial.iter().all(|frame| frame.0 >= 0));
    assert!(initial
        .iter()
        .all(|frame| (frame.1, frame.2) == (monitor.0, monitor.1)));
    // 60 fps 節流：兩秒內不會超過約 121 格。
    assert!(initial.len() <= 122, "節流失效：{} 格", initial.len());

    sample.store(true, Ordering::Release);
    let pixel = pixels.recv_timeout(Duration::from_secs(3)).unwrap();
    eprintln!("DDA 方塊像素 BGRA {pixel:?}");
    for (actual, expected) in pixel[..3].iter().zip([0u8, 255, 0]) {
        assert!(actual.abs_diff(expected) <= 8, "像素 {pixel:?} 不是綠色");
    }

    drop(window);
    notice_until(&notices, |notice| *notice == CaptureNotice::WindowLost);
    let _replacement = TestWindow::new();
    notice_until(&notices, |notice| {
        matches!(notice, CaptureNotice::WindowFound { monitor: true, .. })
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let resumed = loop {
        if frames.recv_timeout(Duration::from_millis(100)).is_ok() {
            break true;
        }
        if Instant::now() > deadline {
            break false;
        }
    };
    assert!(resumed, "視窗重新出現後沒有新影格");
    let started = Instant::now();
    capture.stop();
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn dda_reports_missing_window() {
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    let error = dda::gpu_for_pid(u32::MAX).err().unwrap();
    assert!(
        error.to_string().starts_with("window_not_found:"),
        "{error:#}"
    );
}

/// 裝置不在擁有螢幕的轉接器上（例：Microsoft Basic Render Driver，沒有任何輸出）時，
/// DDA 必須以 capture_failed 明確拒絕，而不是靜默沒有畫面。
#[test]
fn dda_rejects_device_on_adapter_without_the_monitor() {
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    let _window = TestWindow::new();
    // SAFETY: 只列舉轉接器與輸出，COM 物件由 windows crate 管理。
    let outputless: Option<IDXGIAdapter> = unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().unwrap();
        (0..)
            .map_while(|index| match factory.EnumAdapters1(index) {
                Ok(adapter) => Some(adapter),
                Err(error) => {
                    assert_eq!(error.code(), DXGI_ERROR_NOT_FOUND);
                    None
                }
            })
            .find(|adapter| adapter.EnumOutputs(0).is_err())
            .map(|adapter| adapter.cast().unwrap())
    };
    let Some(adapter) = outputless else {
        eprintln!("沒有無輸出的轉接器，略過");
        return;
    };
    let gpu = match Gpu::create_on(&adapter) {
        Ok(gpu) => gpu,
        Err(error) => {
            eprintln!("無輸出的轉接器無法建立裝置（{error:#}），略過");
            return;
        }
    };
    struct Empty;
    impl FrameConsumer for Empty {
        fn on_frame(&mut self, _: &CapturedFrame<'_>) {}
    }
    let (notices, _) = mpsc::channel();
    let error = Capture::start_with(
        CaptureMethod::Dda,
        &gpu,
        CaptureOptions {
            pid: std::process::id(),
            max_fps: 60,
            origin_ticks: clock::now_ticks(),
        },
        Box::new(Empty),
        notices,
    )
    .err()
    .unwrap();
    let message = format!("{error:#}");
    assert!(message.starts_with("capture_failed:"), "{message}");
    assert!(message.contains("顯示卡"), "{message}");
}
