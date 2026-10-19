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

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use capture::small::{SmallFrameExtractor, SmallFrames};
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
                        lpszClassName: w!("AditorrecDdaTest"),
                        ..Default::default()
                    })
                });
                assert_ne!(*atom, 0);
                let hwnd = CreateWindowExW(
                    WS_EX_TOPMOST | WS_EX_NOACTIVATE,
                    w!("AditorrecDdaTest"),
                    w!("aditorrec DDA 擷取測試"),
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

    fn foreground(&self) {
        foreground(HWND(self.hwnd as *mut _));
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
    small: Option<(SmallFrameExtractor, Sender<SmallFrames>)>,
}

impl FrameConsumer for Consumer {
    fn on_frame(&mut self, frame: &CapturedFrame<'_>) {
        let _ = self.frames.send((frame.pts, frame.width, frame.height));
        if let Some((extractor, output)) = &mut self.small {
            if let Some(small) =
                extractor.on_frame(frame.texture, frame.width, frame.height, frame.pts)
            {
                let _ = output.send(small);
            }
        }
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
#[ignore = "需要可切換前景的互動桌面；此執行環境的 SetForegroundWindow 拒絕啟用測試視窗"]
fn dda_captures_monitor_pixels_with_increasing_pts_and_reconnects() {
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    let window = TestWindow::new();
    window.foreground();
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
            small: None,
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

fn foreground(hwnd: HWND) {
    // SAFETY: 只要求視窗管理員切換前景，不開啟任何程序；系統拒絕時明確讓互動測試失敗。
    unsafe {
        assert!(
            SetForegroundWindow(hwnd).as_bool(),
            "互動桌面拒絕切換前景視窗"
        );
        assert_eq!(GetForegroundWindow(), hwnd);
    }
}

struct RecorderProcess(Child);

impl Drop for RecorderProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// 同時檢查送給編碼器的 BGRA 來源、小圖與真實 recorder 的 JSON-lines IPC。
#[test]
#[ignore = "需要可切換前景的互動桌面；此執行環境的 SetForegroundWindow 拒絕啟用測試視窗"]
fn dda_blacks_frames_and_emits_events_when_another_process_takes_foreground() {
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    // SAFETY: 僅保存原前景視窗，作為另一個 PID 的視窗；不取得其程序控制代碼。
    let other = unsafe { GetForegroundWindow() };
    let mut other_pid = 0;
    unsafe { GetWindowThreadProcessId(other, Some(&mut other_pid)) };
    assert_ne!(other_pid, 0);
    assert_ne!(other_pid, std::process::id());
    let window = TestWindow::new();
    window.foreground();
    let gpu = dda::gpu_for_pid(std::process::id()).unwrap();
    let (point, monitor) = window.block_center_on_monitor();
    let origin = clock::now_ticks();
    let (frames_tx, frames) = mpsc::channel();
    let (pixels_tx, pixels) = mpsc::channel();
    let (small_tx, small) = mpsc::channel();
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
            small: Some((
                SmallFrameExtractor::new(
                    &gpu,
                    types::FramesSpec {
                        banner: [0, 0, 96, 48],
                        spec: [960, 540, 96, 48],
                        base: [1920, 1080],
                    },
                )
                .unwrap(),
                small_tx,
            )),
        }),
        notices_tx,
    )
    .unwrap();
    let mut process = RecorderProcess(
        Command::new(env!("CARGO_BIN_EXE_aditorrec"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let (events_tx, events) = mpsc::channel();
    let stdout = process.0.stdout.take().unwrap();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let value: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
            if events_tx.send(value).is_err() {
                break;
            }
        }
    });
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/foreground-tests")
        .join(format!("{}-{}", std::process::id(), origin));
    let request = serde_json::json!({"id":1,"cmd":"start","pid":std::process::id(),
        "session_dir":dir,"session_id":format!("foreground-{}",origin),"capture":"dda",
        "encode":null,"audio":null,
        "frames":{"banner":[0,0,96,48],"spec":[960,540,96,48],"base":[1920,1080]}});
    writeln!(process.0.stdin.as_mut().unwrap(), "{request}").unwrap();
    let event_until = |name: &str| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let value = events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            assert_ne!(value["ev"], "error", "{value}");
            if value["ev"] == name {
                break value;
            }
        }
    };
    event_until("started");
    thread::sleep(Duration::from_millis(500));
    sample.store(true, Ordering::Release);
    let visible = pixels.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(visible[1] >= 247, "遊戲前景未擷取到綠色方塊：{visible:?}");

    foreground(other);
    let hidden = notice_until(&notices, |n| matches!(n, CaptureNotice::GameHidden { .. }));
    let CaptureNotice::GameHidden { pts: hidden_pts } = hidden else {
        unreachable!()
    };
    let hidden_event = event_until("game_hidden");
    assert!((0.0..5.0).contains(&hidden_event["pts"].as_f64().unwrap()));
    sample.store(true, Ordering::Release);
    assert_eq!(
        pixels.recv_timeout(Duration::from_secs(3)).unwrap(),
        [0, 0, 0, 255]
    );
    // 停止測試視窗的重繪，確認黑幀不依賴新的桌面影格。
    unsafe { KillTimer(Some(HWND(window.hwnd as *mut _)), 1).unwrap() };
    thread::sleep(Duration::from_millis(1200));
    let hidden_frames: Vec<_> = frames.try_iter().filter(|f| f.0 > hidden_pts).collect();
    assert!(
        hidden_frames.len() >= 55,
        "隱藏期間只有 {} 格",
        hidden_frames.len()
    );
    assert!(hidden_frames.iter().all(|f| (f.1, f.2) == monitor));
    assert!(hidden_frames
        .windows(2)
        .all(|p| p[1].0 > p[0].0 && p[1].0 - p[0].0 <= TICKS_PER_SEC / 10));
    let hidden_small: Vec<_> = small.try_iter().filter(|s| s.pts > hidden_pts).collect();
    assert!(hidden_small.len() >= 3, "隱藏期間小圖未持續輸出");
    assert!(
        hidden_small.iter().all(|s| s
            .banner
            .iter()
            .chain(&s.spec)
            .chain(s.thumb.iter().flatten())
            .all(|&v| v == 0)),
        "隱藏期間小圖不是全黑"
    );
    assert!(!notices
        .try_iter()
        .any(|n| matches!(n, CaptureNotice::GameHidden { .. })));

    window.foreground();
    notice_until(&notices, |n| matches!(n, CaptureNotice::GameVisible { .. }));
    let visible_event = event_until("game_visible");
    assert!(visible_event["pts"].as_f64().unwrap() > hidden_event["pts"].as_f64().unwrap());
    unsafe { assert_ne!(SetTimer(Some(HWND(window.hwnd as *mut _)), 1, 16, None), 0) };
    thread::sleep(Duration::from_millis(100));
    sample.store(true, Ordering::Release);
    let restored = pixels.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(restored[1] >= 247, "恢復前景後不是綠色：{restored:?}");
    capture.stop();
    process.0.stdin.take();
    assert!(process.0.wait().unwrap().success());
    reader.join().unwrap();
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
