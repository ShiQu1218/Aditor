//! Validate DDA (Desktop Duplication) capture on a real D3D11 device: use this test process's topmost window in place of a game,
//! and capture its entire display; does not open or operate a game process. Requires an interactive signed-in desktop with the display on.
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
/// Background COLORREF 0x00BBGGRR: blue; central square: green.
const BACKGROUND: u32 = 0xff0000;
const BLOCK: u32 = 0x00ff00;

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    // SAFETY: The window's owning thread handles all messages; only draw our window.
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
                // Change corner colors each frame to keep the desktop updating.
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
    // SAFETY: dc is valid between BeginPaint/EndPaint; brush is released immediately after FillRect.
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
            // SAFETY: The test only sets its window thread's DPI mode; HWND and the message loop remain on that thread.
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

    /// Green square center in its display's coordinate system, and the display's physical dimensions.
    fn block_center_on_monitor(&self) -> ((u32, u32), (u32, u32)) {
        // SAFETY: This thread is per-monitor DPI aware to obtain physical pixel coordinates; HWND remains valid during the test.
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
        // SAFETY: The window's owning thread handles WM_CLOSE; HWND is unused after join.
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

/// Record each frame's pts/dimensions; when `sample` is true, read the requested pixel during the call (synchronous Map is allowed only in tests).
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
        // SAFETY: The source texture is valid during this call; staging is 1×1 BGRA on the same device, immediately unmapped after Map.
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
    // SAFETY: Complete 1×1 staging texture descriptor; the windows crate manages output.
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
#[ignore = "Requires an interactive desktop that permits foreground switching; SetForegroundWindow refuses to activate the test window in this environment"]
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
            capture_cursor: true,
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
    eprintln!("DDA received {} frames over two seconds (display {monitor:?})", initial.len());
    assert!(initial.len() >= 30, "Only received {} frames over two seconds", initial.len());
    // pts and QPC share an origin: the last frame is less than half a second old (grid alignment shifts forward by at most half a frame).
    let age = clock::now_ticks() - origin - initial.last().unwrap().0;
    assert!(
        (-TICKS_PER_SEC / 120..TICKS_PER_SEC / 2).contains(&age),
        "Last frame is {age} ticks old"
    );
    // pts aligns to a 1/60 s grid: intervals are whole frames (allow 1 tick of integer division error).
    let slot = TICKS_PER_SEC as f64 / 60.0;
    for pair in initial.windows(2) {
        let slots = (pair[1].0 - pair[0].0) as f64 / slot;
        assert!(
            slots >= 0.99 && (slots - slots.round()).abs() * slot <= 1.5,
            "Interval of {slots} frames"
        );
    }
    assert!(initial.windows(2).all(|pair| pair[0].0 < pair[1].0));
    assert!(initial.iter().all(|frame| frame.0 >= 0));
    assert!(initial
        .iter()
        .all(|frame| (frame.1, frame.2) == (monitor.0, monitor.1)));
    // 60 fps throttling: no more than about 121 frames in two seconds.
    assert!(initial.len() <= 122, "Throttling failed: {} frames", initial.len());

    sample.store(true, Ordering::Release);
    let pixel = pixels.recv_timeout(Duration::from_secs(3)).unwrap();
    eprintln!("DDA square pixel BGRA {pixel:?}");
    for (actual, expected) in pixel[..3].iter().zip([0u8, 255, 0]) {
        assert!(actual.abs_diff(expected) <= 8, "Pixel {pixel:?} is not green");
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
    assert!(resumed, "No new frames after the window reappeared");
    let started = Instant::now();
    capture.stop();
    assert!(started.elapsed() < Duration::from_secs(2));
}

fn foreground(hwnd: HWND) {
    // SAFETY: Only request a foreground switch from the window manager without opening processes; explicitly fail the interactive test if denied.
    unsafe {
        assert!(
            SetForegroundWindow(hwnd).as_bool(),
            "Interactive desktop denied foreground switching"
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

/// Check BGRA encoder input, small images, and the real recorder's JSON-lines IPC together.
#[test]
#[ignore = "Requires an interactive desktop that permits foreground switching; SetForegroundWindow refuses to activate the test window in this environment"]
fn dda_keeps_recording_and_emits_events_when_another_process_takes_foreground() {
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    // SAFETY: Only save the original foreground window as another PID's window without obtaining its process handle.
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
            capture_cursor: true,
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
    killfeed: None,
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
    assert!(visible[1] >= 247, "Green square not captured while game is foreground: {visible:?}");

    foreground(other);
    let hidden = notice_until(&notices, |n| matches!(n, CaptureNotice::GameHidden { .. }));
    let CaptureNotice::GameHidden { pts: hidden_pts } = hidden else {
        unreachable!()
    };
    let hidden_event = event_until("game_hidden");
    assert!((0.0..5.0).contains(&hidden_event["pts"].as_f64().unwrap()));
    // DDA keeps recording the real desktop while hidden; only the events change.
    thread::sleep(Duration::from_millis(500));
    let hidden_frames: Vec<_> = frames.try_iter().filter(|f| f.0 > hidden_pts).collect();
    assert!(!hidden_frames.is_empty(), "No frames while hidden");
    assert!(hidden_frames.iter().all(|f| (f.1, f.2) == monitor));
    assert!(small.try_iter().any(|s| s.pts > hidden_pts), "Small-image output stopped while hidden");

    window.foreground();
    notice_until(&notices, |n| matches!(n, CaptureNotice::GameVisible { .. }));
    let visible_event = event_until("game_visible");
    assert!(visible_event["pts"].as_f64().unwrap() > hidden_event["pts"].as_f64().unwrap());
    thread::sleep(Duration::from_millis(100));
    sample.store(true, Ordering::Release);
    let restored = pixels.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(restored[1] >= 247, "Not green after returning to foreground: {restored:?}");
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

/// When the device is not on the adapter owning the display (for example, Microsoft Basic Render Driver without outputs),
/// DDA must explicitly reject it with capture_failed instead of silently producing no frames.
#[test]
fn dda_rejects_device_on_adapter_without_the_monitor() {
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    let _window = TestWindow::new();
    // SAFETY: Only enumerate adapters and outputs; the windows crate manages COM objects.
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
        eprintln!("No adapter without outputs; skipping");
        return;
    };
    let gpu = match Gpu::create_on(&adapter) {
        Ok(gpu) => gpu,
        Err(error) => {
            eprintln!("Cannot create device on adapter without outputs ({error:#}); skipping");
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
            capture_cursor: true,
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
    assert!(message.contains("adapter"), "{message}");
}
