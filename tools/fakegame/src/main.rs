mod gpu;
mod stats;

use anyhow::{bail, ensure, Context, Result};
use std::{
    fs,
    io::{BufWriter, Write},
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::w,
    Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        Media::{timeBeginPeriod, timeEndPeriod},
        System::{
            LibraryLoader::GetModuleHandleW,
            Performance::{QueryPerformanceCounter, QueryPerformanceFrequency},
        },
        UI::{
            HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
            WindowsAndMessaging::*,
        },
    },
};

#[derive(Debug)]
struct Options {
    raw: PathBuf,
    csv: PathBuf,
    size: (u32, u32),
    window: Option<(u32, u32)>,
    fps: f64,
    cap: f64,
    duration: f64,
    warmup: f64,
    passes: u32,
    start: Option<PathBuf>,
    ready: Option<PathBuf>,
    measurement: Option<PathBuf>,
}

fn dimensions(s: &str) -> Result<(u32, u32)> {
    let (w, h) = s.split_once('x').context("Expected WxH")?;
    let size: (u32, u32) = (w.parse()?, h.parse()?);
    ensure!(
        size.0 > 0
            && size.1 > 0
            && size.0 <= 16384
            && size.1 <= 16384
            && size.0.is_multiple_of(2)
            && size.1.is_multiple_of(2),
        "Dimensions must be positive, even, and <= 16384"
    );
    Ok(size)
}

fn options(args: impl Iterator<Item = String>) -> Result<Options> {
    let mut o = Options {
        raw: PathBuf::new(),
        csv: "frames.csv".into(),
        size: (1920, 1080),
        window: None,
        fps: 60.0,
        cap: 0.0,
        duration: 60.0,
        warmup: 5.0,
        passes: 0,
        start: None,
        ready: None,
        measurement: None,
    };
    let mut args = args;
    while let Some(key) = args.next() {
        if key == "--help" {
            println!("fakegame --raw FILE [--size 1920x1080] [--clip-fps 60] [--windowed WxH] [--load-passes N] [--fps-cap 0] [--duration-s 60] [--warmup-s 5] [--csv FILE]\nHarness gates: --start-file FILE --ready-file FILE --measurement-file FILE");
            std::process::exit(0);
        }
        let value = args
            .next()
            .with_context(|| format!("Missing value for {key}"))?;
        match key.as_str() {
            "--raw" => o.raw = value.into(),
            "--csv" => o.csv = value.into(),
            "--size" => o.size = dimensions(&value)?,
            "--windowed" => o.window = Some(dimensions(&value)?),
            "--clip-fps" => o.fps = value.parse()?,
            "--fps-cap" => o.cap = value.parse()?,
            "--duration-s" => o.duration = value.parse()?,
            "--warmup-s" => o.warmup = value.parse()?,
            "--load-passes" => o.passes = value.parse()?,
            "--start-file" => o.start = Some(value.into()),
            "--ready-file" => o.ready = Some(value.into()),
            "--measurement-file" => o.measurement = Some(value.into()),
            _ => bail!("Unknown option: {key}"),
        }
    }
    ensure!(!o.raw.as_os_str().is_empty(), "--raw is required");
    ensure!(
        o.fps.is_finite() && o.fps > 0.0 && o.cap.is_finite() && o.cap >= 0.0,
        "Invalid frame rate"
    );
    if o.cap > 0.0 {
        ensure!(
            Duration::try_from_secs_f64(1.0 / o.cap).is_ok_and(|d| !d.is_zero()),
            "Frame cap interval is outside timer precision/range"
        );
    }
    ensure!(
        o.duration.is_finite() && o.duration > 0.0 && o.warmup.is_finite() && o.warmup >= 0.0,
        "Invalid duration"
    );
    ensure!(o.passes <= 10000, "Too many load passes");
    Ok(o)
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        WM_KEYDOWN if wp.0 == 27 => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

struct Window(HWND);
impl Drop for Window {
    fn drop(&mut self) {
        // SAFETY: Destroy only this thread's window, if it is still alive.
        unsafe {
            if IsWindow(Some(self.0)).as_bool() {
                let _ = DestroyWindow(self.0);
            }
        }
    }
}

struct TimerResolution;
impl Drop for TimerResolution {
    fn drop(&mut self) {
        // SAFETY: Balance this process's successful one-millisecond timer request.
        unsafe { timeEndPeriod(1) };
    }
}

fn qpc() -> Result<i64> {
    let mut value = 0;
    // SAFETY: Valid writable counter output.
    unsafe {
        QueryPerformanceCounter(&mut value)?;
    }
    Ok(value)
}

fn run(o: Options) -> Result<()> {
    let _timer = if o.cap > 0.0 {
        // SAFETY: Request precise sleeps for the optional cap and restore them on every exit.
        ensure!(
            unsafe { timeBeginPeriod(1) } == 0,
            "Timer resolution request failed"
        );
        Some(TimerResolution)
    } else {
        None
    };
    // SAFETY: Window creation and its message loop stay on this thread.
    let (window, output) = unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let instance = HINSTANCE(GetModuleHandleW(None)?.0);
        ensure!(
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: instance,
                lpszClassName: w!("AditorFakeGame"),
                ..Default::default()
            }) != 0,
            "RegisterClassW failed"
        );
        let output = o.window.unwrap_or((
            GetSystemMetrics(SM_CXSCREEN) as u32,
            GetSystemMetrics(SM_CYSCREEN) as u32,
        ));
        let style = if o.window.is_some() {
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX
        } else {
            WS_POPUP
        };
        let mut rect = windows::Win32::Foundation::RECT {
            right: output.0 as i32,
            bottom: output.1 as i32,
            ..Default::default()
        };
        AdjustWindowRect(&mut rect, style, false)?;
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("AditorFakeGame"),
            w!("Aditor Fake Apex"),
            style | WS_VISIBLE,
            0,
            0,
            rect.right - rect.left,
            rect.bottom - rect.top,
            None,
            None,
            Some(instance),
            None,
        )?;
        (Window(hwnd), output)
    };
    let gpu = gpu::Gpu::new(window.0, &o.raw, o.size, output)?;
    let mut frequency = 0;
    // SAFETY: Valid writable frequency output.
    unsafe {
        QueryPerformanceFrequency(&mut frequency)?;
    }
    let tick_ms = 1000.0 / frequency as f64;
    let mut rows = Vec::new();
    let mut visible = false;
    let mut warmup_start = None;
    let mut measure_start = None;
    let mut previous = None;
    let mut cap_next = Instant::now();
    let mut message = MSG::default();
    let gate_deadline = Instant::now() + Duration::from_secs(180);
    let mut visible_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        // SAFETY: Dispatch messages for this thread's window only.
        unsafe {
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                if message.message == WM_QUIT {
                    break;
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        if message.message == WM_QUIT {
            break;
        }
        let now = qpc()?;
        if visible && warmup_start.is_none() && o.start.as_ref().is_none_or(|p| p.exists()) {
            warmup_start = Some(now);
        }
        ensure!(
            warmup_start.is_some() || Instant::now() < gate_deadline,
            "Timed out waiting for start gate"
        );
        if measure_start.is_none()
            && warmup_start.is_some_and(|start| (now - start) as f64 * tick_ms >= o.warmup * 1000.0)
        {
            measure_start = Some(now);
            previous = None;
            if let Some(path) = &o.measurement {
                let epoch = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64() * 1000.0;
                fs::write(
                    path,
                    format!(
                        "{{\"epoch_ms\":{epoch},\"qpc_ms\":{}}}\n",
                        now as f64 * tick_ms
                    ),
                )?;
            }
        }
        if measure_start.is_some_and(|start| (now - start) as f64 * tick_ms >= o.duration * 1000.0)
        {
            break;
        }
        let timeline = measure_start
            .or(warmup_start)
            .map_or(0.0, |start| (now - start) as f64 * tick_ms / 1000.0);
        gpu.draw(timeline, o.fps, o.passes);
        if o.cap > 0.0 {
            while Instant::now() < cap_next {
                let remaining = cap_next - Instant::now().min(cap_next);
                if remaining > Duration::from_millis(2) {
                    std::thread::sleep(remaining - Duration::from_millis(1));
                } else {
                    std::hint::spin_loop();
                }
            }
        }
        let stamp = qpc()?;
        if !gpu.present()? {
            ensure!(
                measure_start.is_none(),
                "Window occluded during measurement"
            );
            ensure!(
                Instant::now() < visible_deadline,
                "No visible presentation for 15 seconds; run on an unlocked interactive desktop, outside a hidden/sandbox desktop"
            );
            warmup_start = None;
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }
        visible_deadline = Instant::now() + Duration::from_secs(15);
        if !visible {
            visible = true;
            if let Some(path) = &o.ready {
                fs::write(path, "ready\n")?;
            }
        }
        if measure_start.is_some() {
            if let Some(last) = previous {
                rows.push((stamp as f64 * tick_ms, (stamp - last) as f64 * tick_ms));
            }
            previous = Some(stamp);
        }
        if o.cap > 0.0 {
            cap_next = (cap_next + Duration::from_secs_f64(1.0 / o.cap)).max(Instant::now());
        }
    }
    let mut csv = BufWriter::new(fs::File::create(&o.csv)?);
    writeln!(csv, "frame_index,qpc_ms,frame_ms")?;
    for (i, (stamp, ms)) in rows.iter().enumerate() {
        writeln!(csv, "{i},{stamp:.6},{ms:.6}")?;
    }
    csv.flush()?;
    println!(
        "{}",
        serde_json::to_string(&stats::summarize(
            &rows.iter().map(|r| r.1).collect::<Vec<_>>()
        )?)?
    );
    Ok(())
}

fn main() -> Result<()> {
    run(options(std::env::args().skip(1))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_options() {
        let parse = |s: &str| options(s.split_whitespace().map(str::to_string));
        assert!(parse("--raw video.nv12 --windowed 1280x720 --fps-cap 120").is_ok());
        for s in [
            "--raw v --size 1919x1080",
            "--raw v --duration-s NaN",
            "--raw v --fps-cap -1",
            "--raw v --fps-cap 1e-300",
            "--raw v --fps-cap 1e300",
            "--raw v --warmup-s -1",
            "--raw v --unknown 1",
            "--raw",
        ] {
            assert!(parse(s).is_err(), "{s}");
        }
    }
}
