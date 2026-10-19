//! 在真實 D3D11 裝置上驗證 WGC、重接與小圖；不開啟或操作遊戲程序。
#![allow(dead_code)]

#[path = "../src/capture/mod.rs"]
mod capture;
#[path = "../src/clock.rs"]
mod clock;
#[path = "../src/gpu.rs"]
mod gpu;
#[path = "../src/types.rs"]
mod types;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use capture::small::{SmallFrameExtractor, SmallFrames};
use capture::{Capture, CaptureNotice, CaptureOptions, CapturedFrame, FrameConsumer};
use clock::TICKS_PER_SEC;
use gpu::Gpu;
use types::{FramesSpec, THUMB_H, THUMB_W};
use windows::core::w;
use windows::core::Interface;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::*;

static HARDWARE: Mutex<()> = Mutex::new(());
const FRAMES: FramesSpec = FramesSpec {
    banner: [192, 216, 192, 108],
    spec: [960, 540, 192, 108],
    base: [1920, 1080],
};
const SET_BLACK: u32 = WM_APP + 1;
const RESIZE: u32 = WM_APP + 2;

struct WindowState {
    black: bool,
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    // SAFETY: 所有訊息由此視窗的擁有執行緒處理；state 指標來自 CreateWindowExW 且活到訊息迴圈結束。
    unsafe {
        match message {
            WM_NCCREATE => {
                let create = &*(lp.0 as *const CREATESTRUCTW);
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
                LRESULT(1)
            }
            SET_BLACK => {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState;
                (*state).black = wp.0 != 0;
                LRESULT(0)
            }
            RESIZE => {
                SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    wp.0 as i32,
                    lp.0 as i32,
                    SWP_NOMOVE | SWP_NOACTIVATE,
                )
                .unwrap();
                LRESULT(0)
            }
            WM_TIMER => {
                let _ = InvalidateRect(Some(hwnd), None, false);
                LRESULT(0)
            }
            WM_PAINT => {
                let state = &*(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowState);
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut paint);
                let mut rect = RECT::default();
                GetClientRect(hwnd, &mut rect).unwrap();
                fill(dc, rect, if state.black { 0 } else { 0xff0000 });
                if !state.black {
                    fill(
                        dc,
                        RECT {
                            left: rect.right / 10,
                            top: rect.bottom / 5,
                            right: rect.right / 5,
                            bottom: rect.bottom * 3 / 10,
                        },
                        0x0000ff,
                    );
                    fill(
                        dc,
                        RECT {
                            left: rect.right / 2,
                            top: rect.bottom / 2,
                            right: rect.right * 3 / 5,
                            bottom: rect.bottom * 3 / 5,
                        },
                        0x00ff00,
                    );
                }
                static TICK: AtomicU32 = AtomicU32::new(0);
                let tick = TICK.fetch_add(1, Ordering::Relaxed);
                let color = if state.black {
                    (tick % 2) * 0x010101
                } else {
                    tick % 256
                };
                fill(
                    dc,
                    RECT {
                        left: rect.right - 16,
                        top: rect.bottom - 16,
                        right: rect.right,
                        bottom: rect.bottom,
                    },
                    color,
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
    fn new(width: i32, height: i32) -> Self {
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
                        lpszClassName: w!("ApexrecB2Test"),
                        ..Default::default()
                    })
                });
                assert_ne!(*atom, 0);
                let mut state = WindowState { black: false };
                let hwnd = CreateWindowExW(
                    WS_EX_TOPMOST | WS_EX_NOACTIVATE,
                    w!("ApexrecB2Test"),
                    w!("apexrec B2 擷取測試"),
                    WS_POPUP | WS_VISIBLE,
                    40,
                    40,
                    width,
                    height,
                    None,
                    None,
                    Some(instance),
                    Some((&mut state as *mut WindowState).cast()),
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

    fn resize(&self, width: i32, height: i32) {
        // SAFETY: 此 HWND 在 TestWindow 存活期間有效；只調整測試視窗的尺寸。
        unsafe {
            PostMessageW(
                Some(HWND(self.hwnd as *mut _)),
                RESIZE,
                WPARAM(width as usize),
                LPARAM(height as isize),
            )
            .unwrap()
        };
    }

    fn black(&self) {
        // SAFETY: 訊息只傳給自己的測試視窗，不攜帶指標。
        unsafe {
            PostMessageW(
                Some(HWND(self.hwnd as *mut _)),
                SET_BLACK,
                WPARAM(1),
                LPARAM(0),
            )
            .unwrap()
        };
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

struct Consumer {
    small: SmallFrameExtractor,
    frames: Sender<(i64, u32, u32)>,
    images: Sender<SmallFrames>,
}

impl FrameConsumer for Consumer {
    fn on_frame(&mut self, frame: &CapturedFrame<'_>) {
        let _ = self.frames.send((frame.pts, frame.width, frame.height));
        if let Some(small) =
            self.small
                .on_frame(frame.texture, frame.width, frame.height, frame.pts)
        {
            let _ = self.images.send(small);
        }
    }
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

fn assert_color(bytes: &[u8], bgr: [u8; 3], width: usize, height: usize) {
    assert_eq!(bytes.len(), width * height * 3);
    // 略過縮放濾波的邊緣像素，仍檢查區塊中央的完整一列。
    for pixel in
        bytes[(height / 2 * width + 8) * 3..(height / 2 * width + width - 8) * 3].chunks_exact(3)
    {
        for (actual, expected) in pixel.iter().zip(bgr) {
            assert!(
                actual.abs_diff(expected) <= 8,
                "像素 {pixel:?} 與 {bgr:?} 不符"
            );
        }
    }
}

#[test]
fn wgc_captures_pixels_resizes_reconnects_and_falls_back_to_monitor() {
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    let gpu = Gpu::create().unwrap();
    let dxgi: IDXGIDevice = gpu.device.cast().unwrap();
    // SAFETY: 只讀取測試 D3D11 裝置的轉接器資訊，COM 物件在查詢期間有效。
    let adapter = unsafe { dxgi.GetAdapter().unwrap().GetDesc().unwrap() };
    let end = adapter
        .Description
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(adapter.Description.len());
    eprintln!(
        "WGC 測試轉接器：{}",
        String::from_utf16_lossy(&adapter.Description[..end])
    );
    let window = TestWindow::new(960, 540);
    let (frames_tx, frames) = mpsc::channel();
    let (images_tx, images) = mpsc::channel();
    let (notices_tx, notices) = mpsc::channel();
    let capture = Capture::start(
        &gpu,
        CaptureOptions {
            pid: std::process::id(),
            max_fps: 60,
            origin_ticks: clock::now_ticks(),
        },
        Box::new(Consumer {
            small: SmallFrameExtractor::new(&gpu, FRAMES).unwrap(),
            frames: frames_tx,
            images: images_tx,
        }),
        notices_tx,
    )
    .unwrap();
    assert_eq!(
        notice_until(&notices, |_| true),
        CaptureNotice::WindowFound {
            width: 960,
            height: 540,
            monitor: false
        }
    );
    thread::sleep(Duration::from_secs(2));
    let initial: Vec<_> = frames.try_iter().collect();
    eprintln!("WGC 兩秒收到 {} 格", initial.len());
    assert!(initial.len() >= 30, "兩秒只收到 {} 格", initial.len());
    assert!(initial.windows(2).all(|pair| pair[0].0 < pair[1].0));
    assert!(initial.iter().all(|frame| (frame.1, frame.2) == (960, 540)));
    let image = images
        .try_iter()
        .find(|image| image.thumb.is_some())
        .unwrap();
    assert_color(&image.banner, [0, 0, 255], 192, 108);
    assert_color(&image.spec, [0, 255, 0], 192, 108);
    assert_eq!(image.thumb.unwrap().len(), (THUMB_W * THUMB_H) as usize);

    window.resize(1280, 720);
    notice_until(&notices, |notice| {
        *notice
            == CaptureNotice::WindowFound {
                width: 1280,
                height: 720,
                monitor: false,
            }
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    while !frames
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .is_ok_and(|frame| (frame.1, frame.2) == (1280, 720))
    {
        assert!(Instant::now() < deadline);
    }
    drop(window);
    notice_until(&notices, |notice| *notice == CaptureNotice::WindowLost);
    let replacement = TestWindow::new(960, 540);
    notice_until(&notices, |notice| {
        matches!(notice, CaptureNotice::WindowFound { monitor: false, .. })
    });
    replacement.black();
    let fallback = notice_until(&notices, |notice| {
        matches!(notice, CaptureNotice::WindowFound { monitor: true, .. })
    });
    assert!(
        matches!(fallback, CaptureNotice::WindowFound { width, height, .. } if width >= 960 && height >= 540)
    );
    drop(replacement);
    notice_until(&notices, |notice| *notice == CaptureNotice::WindowLost);
    let started = Instant::now();
    capture.stop();
    assert!(started.elapsed() < Duration::from_secs(2));
}

fn color_texture(gpu: &Gpu, width: u32, height: u32) -> ID3D11Texture2D {
    let mut data = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        for x in 0..width {
            let pixel = &mut data[((y * width + x) * 4) as usize..][..4];
            let color = if (width / 10..width / 5).contains(&x)
                && (height / 5..height * 3 / 10).contains(&y)
            {
                [0, 0, 255, 255]
            } else if (width / 2..width * 3 / 5).contains(&x)
                && (height / 2..height * 3 / 5).contains(&y)
            {
                [0, 255, 0, 255]
            } else {
                [255, 0, 0, 255]
            };
            pixel.copy_from_slice(&color);
        }
    }
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
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
    let initial = D3D11_SUBRESOURCE_DATA {
        pSysMem: data.as_ptr().cast(),
        SysMemPitch: width * 4,
        ..Default::default()
    };
    let mut texture = None;
    // SAFETY: 初始像素的長度與列間距符合 texture 描述，CreateTexture2D 在返回前完成複製。
    unsafe {
        gpu.device
            .CreateTexture2D(&desc, Some(&initial), Some(&mut texture))
            .unwrap()
    };
    texture.unwrap()
}

#[test]
fn gpu_small_frames_preserve_roi_colors_cadence_and_previous_pts() {
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    let gpu = Gpu::create().unwrap();
    for (width, height) in [(1920, 1080), (960, 540), (2560, 1440)] {
        let texture = color_texture(&gpu, width, height);
        let mut extractor = SmallFrameExtractor::new(&gpu, FRAMES).unwrap();
        assert_eq!(extractor.banner_size(), (192, 108));
        assert_eq!(extractor.spec_size(), (192, 108));
        assert!(extractor.on_frame(&texture, width, height, 0).is_none());
        let mut received = 0;
        for sample in 1..=8 {
            // SAFETY: Flush 只提交測試裝置的工作，不做同步等待；休眠讓上一批 GPU 命令完成。
            unsafe { gpu.context.Flush() };
            thread::sleep(Duration::from_millis(250));
            let pts = sample * TICKS_PER_SEC / 4;
            let image = extractor.on_frame(&texture, width, height, pts).unwrap();
            received += 1;
            assert_eq!(image.pts, pts - TICKS_PER_SEC / 4);
            assert_eq!(image.thumb.is_some(), (sample - 1) % 4 == 0);
            assert_color(&image.banner, [0, 0, 255], 192, 108);
            assert_color(&image.spec, [0, 255, 0], 192, 108);
            if let Some(thumb) = image.thumb {
                assert_eq!(thumb.len(), (THUMB_W * THUMB_H) as usize);
                assert!(thumb[10 * THUMB_W as usize + 10].abs_diff(29) <= 2);
            }
            assert!(extractor
                .on_frame(&texture, width, height, pts + 1)
                .is_none());
        }
        assert_eq!(received, 8, "{width}×{height} 讀回組數不符");
    }
}

#[test]
fn start_reports_missing_window_and_rejects_zero_fps() {
    struct Empty;
    impl FrameConsumer for Empty {
        fn on_frame(&mut self, _: &CapturedFrame<'_>) {}
    }
    let _lock = HARDWARE.lock().unwrap_or_else(|error| error.into_inner());
    let gpu = Gpu::create().unwrap();
    for (fps, prefix) in [(60, "window_not_found:"), (0, "capture_failed:")] {
        let (notices, _) = mpsc::channel();
        let result = Capture::start(
            &gpu,
            CaptureOptions {
                pid: u32::MAX,
                max_fps: fps,
                origin_ticks: clock::now_ticks(),
            },
            Box::new(Empty),
            notices,
        );
        let error = result.err().unwrap();
        assert!(error.to_string().starts_with(prefix), "{error:#}");
    }
}
