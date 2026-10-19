//! 實機端對端驗證與可重現的 60 秒資源量測；只擷取自己的持續重繪視窗。
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{fence, AtomicU32, AtomicU64, AtomicU8, Ordering},
        mpsc::{self, Receiver},
        Mutex, OnceLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{
            CloseHandle, COLORREF, FILETIME, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM,
        },
        Graphics::Gdi::*,
        System::{
            LibraryLoader::GetModuleHandleW,
            Memory::*,
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{
                GetActiveProcessorCount, GetPriorityClass, GetProcessTimes,
                BELOW_NORMAL_PRIORITY_CLASS,
            },
        },
        UI::{
            HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
            WindowsAndMessaging::*,
        },
    },
};

static HARDWARE: Mutex<()> = Mutex::new(());

unsafe extern "system" fn paint(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    // SAFETY: 只操作此測試執行緒建立的視窗；GDI 資源在相同訊息中成對釋放。
    unsafe {
        match msg {
            WM_TIMER => {
                let _ = InvalidateRect(Some(hwnd), None, false);
                LRESULT(0)
            }
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut ps);
                let mut rect = RECT::default();
                GetClientRect(hwnd, &mut rect).unwrap();
                static TICK: AtomicU32 = AtomicU32::new(0);
                let tick = TICK.fetch_add(1, Ordering::Relaxed);
                let block = RECT {
                    left: rect.right / 10,
                    top: rect.bottom / 5,
                    right: rect.right / 5,
                    bottom: rect.bottom * 3 / 10,
                };
                let brush = CreateSolidBrush(COLORREF(0x0000ff));
                FillRect(dc, &block, brush);
                let _ = DeleteObject(brush.into());
                // 背景不覆蓋紅色方塊：DDA 讀合成後的桌面，可能看到畫到一半的 GDI 視窗。
                let _ = ExcludeClipRect(dc, block.left, block.top, block.right, block.bottom);
                let brush = CreateSolidBrush(COLORREF(0x804020 + (tick % 64) * 0x010101));
                FillRect(dc, &rect, brush);
                let _ = DeleteObject(brush.into());
                let _ = EndPaint(hwnd, &ps);
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
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}

struct Window {
    hwnd: usize,
    worker: Option<JoinHandle<()>>,
}
impl Window {
    fn open(width: i32, height: i32) -> Self {
        let (tx, rx) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            // SAFETY: DPI、視窗與訊息迴圈均限定於此測試執行緒。
            unsafe {
                let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                let instance = HINSTANCE(GetModuleHandleW(None).unwrap().0);
                static CLASS: OnceLock<u16> = OnceLock::new();
                assert_ne!(
                    *CLASS.get_or_init(|| RegisterClassW(&WNDCLASSW {
                        lpfnWndProc: Some(paint),
                        hInstance: instance,
                        lpszClassName: w!("ApexrecE2E"),
                        ..Default::default()
                    })),
                    0
                );
                let hwnd = CreateWindowExW(
                    WS_EX_TOPMOST | WS_EX_NOACTIVATE,
                    w!("ApexrecE2E"),
                    w!("apexrec 錄影整合測試"),
                    WS_POPUP | WS_VISIBLE,
                    0,
                    0,
                    width.min(GetSystemMetrics(SM_CXSCREEN)),
                    height.min(GetSystemMetrics(SM_CYSCREEN)),
                    None,
                    None,
                    Some(instance),
                    None,
                )
                .unwrap();
                assert_ne!(SetTimer(Some(hwnd), 1, 15, None), 0);
                let _ = UpdateWindow(hwnd);
                tx.send(hwnd.0 as usize).unwrap();
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
        Self {
            hwnd: rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            worker: Some(worker),
        }
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        // SAFETY: 訊息只送給自己的視窗；執行緒結束後才丟棄 HWND。
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

struct Process {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<Value>,
    seen: Vec<Value>,
    logs: Option<JoinHandle<String>>,
    output_worker: Option<JoinHandle<()>>,
}
impl Process {
    fn open() -> Self {
        let executable = std::env::var_os("APEXREC_TEST_EXE")
            .map(PathBuf::from)
            .unwrap_or_else(|| env!("CARGO_BIN_EXE_apexrec").into());
        let mut child = Command::new(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (tx, output) = mpsc::channel();
        let output_worker = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if tx
                    .send(serde_json::from_str(&line.unwrap()).unwrap())
                    .is_err()
                {
                    break;
                }
            }
        });
        let logs = thread::spawn(move || {
            let mut log = String::new();
            stderr.read_to_string(&mut log).unwrap();
            log
        });
        Self {
            child,
            input,
            output,
            seen: Vec::new(),
            logs: Some(logs),
            output_worker: Some(output_worker),
        }
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input.as_mut().unwrap(), "{value}").unwrap();
    }
    fn until(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let value = self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|e| panic!("等待 IPC 逾時：{e}；已收到 {:?}", self.seen));
            let found = predicate(&value);
            self.seen.push(value.clone());
            if found {
                return value;
            }
        }
    }
    fn reply(&mut self, id: u64) -> Value {
        self.until(|v| v["id"] == id)
    }
    fn drain(&mut self) {
        self.seen.extend(self.output.try_iter());
    }
    fn exit(&mut self) {
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "EOF 後未結束");
            thread::sleep(Duration::from_millis(10));
        }
        self.output_worker.take().unwrap().join().unwrap();
        self.drain();
        let log = self.logs.take().unwrap().join().unwrap();
        assert!(log.is_empty(), "{log}");
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn directory() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/e2e-results")
        .join(format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&dir).unwrap();
    dir
}
fn start(dir: &Path, id: u64, encode: bool) -> Value {
    json!({"id":id,"cmd":"start","pid":std::process::id(),"session_dir":dir,"session_id":format!("e2e-{}-{id}",dir.file_name().unwrap().to_string_lossy()),
        "encode":if encode { json!({"codec":"hevc","encoder":"auto","fps":60,"height":0,"bitrate_kbps":40000}) } else { Value::Null },
        "audio":{"render":"default","capture":"default","mic_gain":1.0,"mic_enabled":true},
        "frames":{"banner":[220,240,96,48],"spec":[960,540,96,48],"base":[1920,1080]}})
}

struct Mapping {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    bytes: usize,
}
impl Mapping {
    fn open(name: &str) -> Self {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        // SAFETY: 記錄程序仍持有 mapping；名稱以 NUL 結尾，僅以唯讀權限開啟。
        let handle =
            unsafe { OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(wide.as_ptr())) }.unwrap();
        // SAFETY: 映射完整的有效 file mapping，Drop 配對釋放。
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0) };
        assert!(!view.Value.is_null());
        let mut result = Self {
            handle,
            view,
            bytes: 64,
        };
        assert_eq!(result.copy(0, 8), b"APXSHM01");
        assert_eq!(result.u32(8), 1);
        assert_eq!(result.u32(12), 16);
        result.bytes = 64 + result.u32(16) as usize * 16;
        result
    }
    fn copy(&self, offset: usize, len: usize) -> Vec<u8> {
        assert!(offset + len <= self.bytes);
        (offset..offset + len)
            .map(|i| {
                // SAFETY: 版面已驗證且位於有效映射中；每 byte 原子讀取，避免與寫端形成資料競爭。
                unsafe {
                    AtomicU8::from_ptr(self.view.Value.cast::<u8>().add(i)).load(Ordering::Relaxed)
                }
            })
            .collect()
    }
    fn u32(&self, offset: usize) -> u32 {
        u32::from_le_bytes(self.copy(offset, 4).try_into().unwrap())
    }
    fn seq(&self, offset: usize) -> u64 {
        assert!(offset.is_multiple_of(8) && offset + 8 <= self.bytes);
        // SAFETY: 序號是映射內 8 對齊的 u64 欄位，只以原子操作存取。
        u64::from_le(unsafe {
            AtomicU64::from_ptr(self.view.Value.cast::<u8>().add(offset).cast())
                .load(Ordering::Acquire)
        })
    }
    fn verify(&self) -> u64 {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let seq = self.seq(48);
            if seq > 0 {
                let size = self.u32(16) as usize;
                let offset = 64 + ((seq - 1) % 16) as usize * size;
                let end = self.seq(offset + size - 8);
                let pts = i64::from_le_bytes(self.copy(offset + 8, 8).try_into().unwrap());
                let banner = self.copy(offset + 24, 96 * 48 * 3);
                fence(Ordering::Acquire);
                if end == seq && self.seq(offset) == seq {
                    assert!(pts >= 0);
                    assert!(
                        banner
                            .chunks_exact(3)
                            .all(|p| p[0] < 8 && p[1] < 8 && p[2] > 247),
                        "banner 未擷取到紅色色塊：{:?}",
                        &banner[..12]
                    );
                    assert_eq!((self.u32(36), self.u32(40)), (640, 360));
                    return seq;
                }
            }
            assert!(Instant::now() < deadline, "共享記憶體沒有有效槽");
            thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: handle 與 view 由本測試物件獨佔，各釋放一次。
        unsafe {
            let _ = UnmapViewOfFile(self.view);
            let _ = CloseHandle(self.handle);
        }
    }
}

fn ffmpeg(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os("APEXREC_FFMPEG_DIR")
            .expect("端對端錄影測試需要設定 APEXREC_FFMPEG_DIR 為含有 bin 的 FFmpeg 根目錄"),
    )
    .join("bin")
    .join(format!("{name}.exe"))
}
fn verify_recording(dir: &Path, process: &Process, seconds: f64) -> Vec<Value> {
    let index: Vec<Value> = fs::read_to_string(dir.join("index.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let events: Vec<_> = process
        .seen
        .iter()
        .filter(|v| v["ev"] == "segment")
        .collect();
    assert_eq!(index.len(), events.len());
    assert_eq!(
        index.len(),
        fs::read_dir(dir)
            .unwrap()
            .filter(|p| p
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|e| e == "m4s"))
            .count()
    );
    assert!(index.len() >= (seconds / 2.0).floor() as usize);
    let mut combined = fs::File::create(dir.join("combined.mp4")).unwrap();
    combined
        .write_all(&fs::read(dir.join("init.mp4")).unwrap())
        .unwrap();
    let mut end = 0.0;
    for (i, segment) in index.iter().enumerate() {
        assert_eq!(segment["seq"], i + 1);
        let pts = segment["pts"].as_f64().unwrap();
        let dur = segment["dur"].as_f64().unwrap();
        assert!((pts - end).abs() < 0.001);
        if i + 1 < index.len() {
            assert!((dur - 2.0).abs() < 0.05);
        }
        end = pts + dur;
        let path = dir.join(format!("seg_{:06}.m4s", i + 1));
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            segment["bytes"].as_u64().unwrap()
        );
        assert_eq!(events[i]["seq"], segment["seq"]);
        combined.write_all(&fs::read(path).unwrap()).unwrap();
    }
    drop(combined);
    assert!((end - seconds).abs() < 0.5, "索引時長 {end}");
    let meta: Value = serde_json::from_slice(&fs::read(dir.join("session.json")).unwrap()).unwrap();
    assert_eq!(meta["audio"], true);
    assert_eq!(meta["fps"], 60);
    assert_eq!(meta["codec"], "hevc");
    assert_eq!(meta["apexrec_version"], env!("CARGO_PKG_VERSION"));
    let probe = Command::new(ffmpeg("ffprobe"))
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(dir.join("combined.mp4"))
        .output()
        .unwrap();
    assert!(
        probe.status.success(),
        "{}",
        String::from_utf8_lossy(&probe.stderr)
    );
    let probe: Value = serde_json::from_slice(&probe.stdout).unwrap();
    let streams = probe["streams"].as_array().unwrap();
    assert!(streams
        .iter()
        .any(|s| s["codec_name"] == "hevc" && s["codec_type"] == "video"));
    assert!(streams
        .iter()
        .any(|s| s["codec_name"] == "aac" && s["sample_rate"] == "48000" && s["channels"] == 2));
    let duration: f64 = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((duration - seconds).abs() < 0.5, "影音時長 {duration}");
    let decode = Command::new(ffmpeg("ffmpeg"))
        .args(["-v", "error", "-i"])
        .arg(dir.join("combined.mp4"))
        .args(["-f", "null", "-"])
        .output()
        .unwrap();
    assert!(
        decode.status.success() && decode.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&decode.stderr)
    );
    assert!(
        !process.seen.iter().any(|v| v["ev"] == "error"),
        "{:?}",
        process.seen
    );
    index
}

fn resources(child: &Child) -> (f64, usize) {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let mut memory = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    // SAFETY: 只讀取自己建立的 apexrec 子程序；所有輸出結構均有效。
    unsafe {
        let handle = HANDLE(child.as_raw_handle());
        GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).unwrap();
        GetProcessMemoryInfo(
            handle,
            &mut memory,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
        .unwrap();
    }
    let ticks =
        |t: FILETIME| ((u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)) as f64;
    (
        (ticks(kernel) + ticks(user)) / 10_000_000.0,
        memory.PeakWorkingSetSize,
    )
}

fn record(seconds: u64, perf: bool, capture: &str) {
    let _guard = HARDWARE.lock().unwrap_or_else(|e| e.into_inner());
    // DDA 擷取整個螢幕，小圖 ROI 以螢幕座標換算；測試視窗鋪滿主螢幕才與 WGC 的檢查一致。
    // 新視窗出現有淡入動畫；DDA 看的是合成後的桌面，等畫面穩定再開始，避免第一張小圖還是舊桌面。
    let _window = if capture == "dda" {
        let window = Window::open(i32::MAX, i32::MAX);
        // SAFETY: DDA 只在目標 PID 位於前景時送遊戲畫面；只啟用自己建立的測試視窗。
        unsafe {
            assert!(SetForegroundWindow(HWND(window.hwnd as *mut _)).as_bool());
        }
        thread::sleep(Duration::from_secs(1));
        window
    } else {
        Window::open(
            if perf { 2560 } else { 1280 },
            if perf { 1440 } else { 720 },
        )
    };
    let dir = directory();
    let mut process = Process::open();
    let mut request = start(&dir, 1, true);
    request["capture"] = json!(capture);
    process.send(request);
    let started = process.until(|v| v["ev"] == "started" || v["ok"] == false);
    assert_eq!(started["ev"], "started", "{started}");
    assert_eq!(process.reply(1)["ok"], true);
    // SAFETY: 查詢自己建立的子程序優先序，不讀取其他程序。
    assert_eq!(
        unsafe { GetPriorityClass(HANDLE(process.child.as_raw_handle())) },
        BELOW_NORMAL_PRIORITY_CLASS.0
    );
    let mapping = Mapping::open(started["shm"].as_str().unwrap());
    let begin = Instant::now();
    let cpu_begin = resources(&process.child).0;
    let first_seq = mapping.verify();
    while begin.elapsed() < Duration::from_secs(seconds) {
        process.drain();
        thread::sleep(Duration::from_millis(25));
    }
    let elapsed = begin.elapsed().as_secs_f64();
    let (cpu_end, _) = resources(&process.child);
    assert!(mapping.verify() > first_seq);
    process.send(json!({"id":2,"cmd":"stop"}));
    assert_eq!(process.reply(2)["ok"], true);
    let (_, peak) = resources(&process.child);
    process.exit();
    let index = verify_recording(&dir, &process, seconds as f64);
    if perf {
        // SAFETY: 0xffff 是 ALL_PROCESSOR_GROUPS，取得全機邏輯處理器數，不受程序 affinity 影響。
        let cores = unsafe { GetActiveProcessorCount(0xffff) };
        assert!(cores > 0);
        let stats = process
            .seen
            .iter()
            .rev()
            .find(|v| v["ev"] == "stats")
            .unwrap();
        let report = json!({"capture":capture,"seconds":elapsed,"logical_processors":cores,"cpu_percent_machine":(cpu_end-cpu_begin)/elapsed/f64::from(cores)*100.0,
            "peak_working_set_bytes":peak,"width":started["width"],"height":started["height"],"encoder":started["encoder"],"fps":started["fps"],
            "dropped":stats["dropped"],"small_dropped":stats["small_dropped"],"segment_bytes":index.iter().map(|s|s["bytes"].clone()).collect::<Vec<_>>(),"directory":dir});
        fs::write(
            dir.join("measurement.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    }
}

#[test]
fn ipc_records_six_seconds_with_audio_segments_and_shared_frames() {
    record(6, false, "wgc");
}

#[test]
fn fit_encodes_non_widescreen_window_at_16_by_9_with_silent_track() {
    let _guard = HARDWARE.lock().unwrap_or_else(|e| e.into_inner());
    let _window = Window::open(800, 600);
    let dir = directory();
    let mut process = Process::open();
    let mut request = start(&dir, 1, true);
    request["encode"]["aspect"] = json!("fit");
    request["encode"]["height"] = json!(720);
    request["audio"]["render_enabled"] = json!(false);
    request["audio"]["mic_enabled"] = json!(false);
    process.send(request);
    let started = process.until(|v| v["ev"] == "started" || v["ok"] == false);
    assert_eq!(started["ev"], "started", "{started}");
    assert_eq!(
        (started["width"].as_u64(), started["height"].as_u64()),
        (Some(1280), Some(720))
    );
    assert_eq!(process.reply(1)["ok"], true);
    thread::sleep(Duration::from_secs(2));
    process.exit();
    verify_recording(&dir, &process, 2.0);
    let output = Command::new(ffmpeg("ffprobe"))
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
        ])
        .arg(dir.join("combined.mp4"))
        .output()
        .unwrap();
    assert!(output.status.success());
    let probe: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(probe["streams"][0]["width"], 1280);
    assert_eq!(probe["streams"][0]["height"], 720);
    let decoded = Command::new(ffmpeg("ffmpeg"))
        .args(["-v", "error", "-i"])
        .arg(dir.join("combined.mp4"))
        .args(["-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
        .output()
        .unwrap();
    assert!(decoded.status.success());
    let pixel = |x: usize, y: usize| &decoded.stdout[(y * 1280 + x) * 3..(y * 1280 + x + 1) * 3];
    assert!(
        pixel(10, 360).iter().all(|value| *value < 12),
        "左側應為黑邊"
    );
    assert!(
        pixel(1270, 360).iter().all(|value| *value < 12),
        "右側應為黑邊"
    );
    assert!(
        pixel(640, 360).iter().any(|value| *value > 30),
        "中間應保留來源畫面"
    );
}

#[test]
#[ignore = "需要可切換前景的互動桌面；此執行環境的 SetForegroundWindow 拒絕啟用測試視窗"]
fn ipc_records_six_seconds_via_desktop_duplication() {
    record(6, false, "dda");
}

#[test]
fn obs_mode_eof_and_failed_start_allow_restart_without_overwriting_files() {
    let _guard = HARDWARE.lock().unwrap_or_else(|e| e.into_inner());
    let _window = Window::open(1280, 720);
    let mut process = Process::open();
    let dir = directory();
    let mut bad = start(&dir, 1, false);
    bad["frames"]["banner"] = json!([1919, 0, 8, 8]);
    process.send(bad);
    assert_eq!(process.reply(1)["code"], "bad_request");
    fs::write(dir.join("index.jsonl"), "保留既有資料").unwrap();
    process.send(start(&dir, 2, false));
    assert_eq!(process.reply(2)["ok"], false);
    assert_eq!(
        fs::read_to_string(dir.join("index.jsonl")).unwrap(),
        "保留既有資料"
    );
    let dir = directory();
    process.send(start(&dir, 3, false));
    let started = process.until(|v| v["ev"] == "started");
    assert_eq!(process.reply(3)["ok"], true);
    let mapping = Mapping::open(started["shm"].as_str().unwrap());
    mapping.verify();
    process.send(start(&directory(), 4, false));
    assert_eq!(process.reply(4)["code"], "busy");
    process.send(json!({"id":5,"cmd":"stop"}));
    assert_eq!(process.reply(5)["ok"], true);
    assert!(!dir.join("init.mp4").exists());
    assert!(!dir.join("index.jsonl").exists());
    process.send(start(&directory(), 6, false));
    process.until(|v| v["ev"] == "started");
    assert_eq!(process.reply(6)["ok"], true);
    process.exit();
    assert_eq!(
        process.seen.iter().filter(|v| v["ev"] == "stopped").count(),
        2
    );
}

#[test]
fn cli_records_the_requested_window_and_reports_resources() {
    let _guard = HARDWARE.lock().unwrap_or_else(|e| e.into_inner());
    let _window = Window::open(1280, 720);
    let dir = directory();
    let output = Command::new("pwsh.exe")
        .args(["-NoProfile", "-File"])
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/rec-cli.ps1"))
        .args([
            "-TargetPid",
            &std::process::id().to_string(),
            "-Seconds",
            "2",
            "-ExePath",
            env!("CARGO_BIN_EXE_apexrec"),
            "-OutputDir",
        ])
        .arg(&dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["encoder"], "hevc_nvenc");
    assert_eq!(report["width"], 1280);
    assert_eq!(report["capture"], "wgc");
    assert!(report["cpu_percent_machine"].as_f64().unwrap() >= 0.0);
    assert!(report["peak_working_set_bytes"].as_u64().unwrap() > 0);
    assert!(!report["segment_bytes"].as_array().unwrap().is_empty());
    assert!(dir.join("measurement.json").exists());
}

#[test]
fn audio_start_failure_releases_resources_and_eof_flushes_encoded_tail() {
    let _guard = HARDWARE.lock().unwrap_or_else(|e| e.into_inner());
    let _window = Window::open(1280, 720);
    let mut process = Process::open();
    let mut bad = start(&directory(), 1, true);
    bad["audio"]["render"] = json!("不存在的音訊端點");
    process.send(bad);
    assert_eq!(process.reply(1)["code"], "audio_failed");
    let dir = directory();
    process.send(start(&dir, 2, true));
    process.until(|v| v["ev"] == "started");
    assert_eq!(process.reply(2)["ok"], true);
    thread::sleep(Duration::from_secs(2));
    process.exit();
    verify_recording(&dir, &process, 2.0);
    assert_eq!(
        process.seen.iter().filter(|v| v["ev"] == "stopped").count(),
        1
    );
}

#[test]
#[ignore = "60 秒實機資源量測；以 release apexrec 執行並保留 measurement.json"]
fn measure_sixty_seconds_hevc_1440p60() {
    record(60, true, "wgc");
}

#[test]
#[ignore = "60 秒實機資源量測（DDA 擷取整個螢幕）；以 release apexrec 執行並保留 measurement.json"]
fn measure_sixty_seconds_hevc_1440p60_dda() {
    record(60, true, "dda");
}
