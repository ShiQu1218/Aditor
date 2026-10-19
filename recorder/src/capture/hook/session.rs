//! OBS `graphics-hook` 注入、共享記憶體初始化、就緒等待與診斷 log pipe。
//! 對照 OBS 32.1.2：`plugins/win-capture/game-capture.c`、`graphics-hook/graphics-hook.c`、
//! `shared/ipc-util/ipc-util/pipe-windows.c`、`plugins/win-capture/inject-library.h`。

use std::mem::size_of;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::ptr;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use windows::core::HSTRING;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, ERROR_IO_PENDING, ERROR_MORE_DATA,
    ERROR_PIPE_CONNECTED, HANDLE, HWND, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Storage::FileSystem::{ReadFile, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    MEMORY_MAPPED_VIEW_ADDRESS,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};
use windows::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenEventW, OpenMutexW, ResetEvent, SetEvent,
    WaitForMultipleObjects, WaitForSingleObject, CREATE_NO_WINDOW, EVENT_MODIFY_STATE, INFINITE,
    SYNCHRONIZATION_SYNCHRONIZE,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use super::protocol::{self, CaptureType, GraphicsOffsets, HookInfo};

const DLL_FILE_NAME: &str = "graphics-hook64.dll";
const INJECTOR_FILE_NAME: &str = "inject-helper64.exe";
const OFFSETS_FILE_NAME: &str = "get-graphics-offsets64.exe";

/// 反作弊相容注入需等待遊戲視窗執行緒處理訊息才會載入 DLL；每 100 ms 輪詢一次。
const HOOK_LOAD_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// 對照 OBS `IPC_PIPE_BUF_SIZE`。
const PIPE_BUFFER_SIZE: u32 = 1024;

/// hook 檔所在目錄；建構時檢查三個檔案都存在。
#[derive(Debug, Clone)]
pub struct HookFiles {
    dir: PathBuf,
}

impl HookFiles {
    pub fn new(dir: impl Into<PathBuf>) -> Result<Self> {
        let files = Self { dir: dir.into() };
        for path in [files.dll(), files.injector(), files.offsets_tool()] {
            if !path.is_file() {
                bail!("hook_unavailable: 找不到 hook 檔案 {}", path.display());
            }
        }
        Ok(files)
    }

    pub fn dll(&self) -> PathBuf {
        self.dir.join(DLL_FILE_NAME)
    }

    pub fn injector(&self) -> PathBuf {
        self.dir.join(INJECTOR_FILE_NAME)
    }

    pub fn offsets_tool(&self) -> PathBuf {
        self.dir.join(OFFSETS_FILE_NAME)
    }
}

/// hook 回報就緒後的共享材質資訊。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SharedTexture {
    pub handle: u32,
    pub width: u32,
    pub height: u32,
    pub format: u32,
}

/// 具名核心物件控制代碼；離開作用域時自動關閉。
struct OwnedHandle(HANDLE);

// SAFETY: Win32 核心物件控制代碼（Event、Mutex、FileMapping、NamedPipe）屬於程序層級，
// 不綁定建立時的執行緒，可安全轉移至其他執行緒使用與關閉。
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: 只關閉本結構獨占擁有的有效控制代碼。
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// `MapViewOfFile` 映射區段；離開作用域時先解除映射再關閉 file mapping 控制代碼。
struct MappedRegion {
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    _map: OwnedHandle,
}

// SAFETY: 映射後的共享記憶體指標在程序地址空間內對所有執行緒有效；
// 由 `HookSession` 獨占持有，不會跨執行緒同時存取。
unsafe impl Send for MappedRegion {}

impl MappedRegion {
    fn as_ptr(&self) -> *mut u8 {
        self.view.Value as *mut u8
    }
}

impl Drop for MappedRegion {
    fn drop(&mut self) {
        if !self.view.Value.is_null() {
            // SAFETY: view 由 open_map 的 MapViewOfFile 建立，且僅在此處解除一次。
            unsafe {
                let _ = UnmapViewOfFile(self.view);
            }
        }
    }
}

fn wide(s: &str) -> HSTRING {
    HSTRING::from(s)
}

fn open_event(name: &str) -> Option<OwnedHandle> {
    // SAFETY: 只依名稱開啟既有的核心事件物件。
    unsafe {
        OpenEventW(
            EVENT_MODIFY_STATE | SYNCHRONIZATION_SYNCHRONIZE,
            false,
            &wide(name),
        )
    }
    .ok()
    .map(OwnedHandle)
}

fn open_mutex(name: &str) -> Option<OwnedHandle> {
    // SAFETY: 只依名稱開啟既有的核心 mutex 物件。
    unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &wide(name)) }
        .ok()
        .map(OwnedHandle)
}

fn open_map(name: &str, size: usize) -> Option<MappedRegion> {
    // SAFETY: 開啟既有的具名 file mapping 並映射指定位元組數；失敗時立即關閉控制代碼。
    unsafe {
        let handle = OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, &wide(name)).ok()?;
        let map = OwnedHandle(handle);
        let view = MapViewOfFile(map.0, FILE_MAP_ALL_ACCESS, 0, 0, size);
        if view.Value.is_null() {
            return None;
        }
        Some(MappedRegion { view, _map: map })
    }
}

/// 對照 OBS `inject-library.h` 的結束碼說明。
fn inject_code_reason(code: i32) -> &'static str {
    match code {
        0 => "成功",
        -1 => "注入失敗",
        -2 => "參數錯誤",
        -3 => "無法開啟程序",
        -4 => "非預期失敗",
        _ => "未知錯誤",
    }
}

/// 檢查 `inject-helper64.exe` 結束碼；非 0 時轉為含中文原因與數值的 `hook_unavailable` 錯誤。
fn check_inject_exit(code: Option<i32>) -> Result<()> {
    match code {
        Some(0) => Ok(()),
        Some(code) => bail!(
            "hook_unavailable: inject-helper64.exe {}（結束碼 {code}）",
            inject_code_reason(code)
        ),
        None => bail!("hook_unavailable: inject-helper64.exe 非預期終止（無結束碼）"),
    }
}

fn fetch_offsets(files: &HookFiles) -> Result<GraphicsOffsets> {
    let output = Command::new(files.offsets_tool())
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .context("hook_unavailable: 無法執行 get-graphics-offsets64.exe")?;
    if !output.status.success() {
        bail!(
            "hook_unavailable: get-graphics-offsets64.exe 失敗（結束碼 {:?}）",
            output.status.code()
        );
    }
    let text = String::from_utf8_lossy(&output.stdout);
    protocol::parse_offsets(&text)
        .map_err(|err| anyhow::anyhow!("hook_unavailable: 解析圖形偏移失敗：{err}"))
}

fn create_keepalive(pid: u32) -> Result<OwnedHandle> {
    let name = protocol::keepalive(pid);
    if open_mutex(&name).is_some() {
        bail!("hook_unavailable: OBS 或其他程式正在擷取此遊戲");
    }
    // SAFETY: 建立具名 mutex；隨後檢查 ERROR_ALREADY_EXISTS 防止與其他程式競爭。
    let raw = unsafe { CreateMutexW(None, false, &wide(&name)) }
        .context("hook_unavailable: 無法建立 keepalive mutex")?;
    let handle = OwnedHandle(raw);
    // SAFETY: CreateMutexW 在 mutex 已存在時仍走成功路徑回傳控制代碼，windows-rs 不會在 Ok 分支讀取或覆寫
    // thread last error，因此此處直接呼叫 GetLastError() 檢查 ERROR_ALREADY_EXISTS 是可靠的。
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        bail!("hook_unavailable: OBS 或其他程式正在擷取此遊戲");
    }
    Ok(handle)
}

fn inject_anticheat(hwnd: HWND, files: &HookFiles) -> Result<()> {
    let mut window_pid = 0u32;
    // SAFETY: 僅查詢視窗執行緒 ID，不開啟程序控制代碼。
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut window_pid)) };
    if thread_id == 0 {
        bail!("hook_unavailable: 無法取得遊戲視窗執行緒 ID");
    }
    let dll = std::path::absolute(files.dll()).unwrap_or_else(|_| files.dll());
    let status = Command::new(files.injector())
        .creation_flags(CREATE_NO_WINDOW.0)
        .arg(&dll)
        .arg("1")
        .arg(thread_id.to_string())
        .status()
        .context("hook_unavailable: 無法執行 inject-helper64.exe")?;
    check_inject_exit(status.code())
}

/// 背景執行緒接收 `\\.\pipe\CaptureHook_Pipe{pid}` 的診斷訊息。
/// 使用 `FILE_FLAG_OVERLAPPED` 搭配手動重設的 `stop_event`：不論執行緒正阻塞在
/// `ConnectNamedPipe` 或已連上後阻塞在 `ReadFile`，Drop 時皆可立即喚醒並取消 I/O，不留孤兒執行緒。
struct PipeLogger {
    stop_event: OwnedHandle,
    worker: Option<JoinHandle<()>>,
}

impl PipeLogger {
    fn spawn(pid: u32) -> Result<Self> {
        // SAFETY: 建立無名手動重設事件，用於通知 log 執行緒結束。
        let stop_raw = unsafe { CreateEventW(None, true, false, None) }
            .context("hook_unavailable: 無法建立 log pipe 停止事件")?;
        let stop_event = OwnedHandle(stop_raw);
        // 直接把 stop_event 控制代碼數值傳給背景執行緒讀取（生命週期由 PipeLogger::drop 先 join 再關閉保證）。
        let stop_handle_val = stop_event.0 .0 as isize;
        let (bound_tx, bound_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("aditorrec-hook-log".into())
            .spawn(move || {
                pipe_logger_loop(pid, stop_handle_val, Some(bound_tx));
            })
            .context("hook_unavailable: 無法啟動 log pipe 執行緒")?;
        // 等待第一次 CreateNamedPipeW 完成再繼續，確保緊接著觸發 Restart 時 hook 端能連上 pipe。
        let _ = bound_rx.recv();
        Ok(Self {
            stop_event,
            worker: Some(worker),
        })
    }
}

impl Drop for PipeLogger {
    fn drop(&mut self) {
        // SAFETY: stop_event 在 worker join 完成前維持有效。
        unsafe {
            let _ = SetEvent(self.stop_event.0);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn create_log_pipe(pid: u32) -> Option<OwnedHandle> {
    let name = wide(&protocol::pipe(pid));
    // SAFETY: 建立雙向、訊息模式、支援 Overlapped 的具名 pipe，使用預設安全描述元。
    let raw = unsafe {
        CreateNamedPipeW(
            &name,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
            1,
            PIPE_BUFFER_SIZE,
            PIPE_BUFFER_SIZE,
            0,
            None,
        )
    };
    if raw.is_invalid() || raw.0.is_null() {
        return None;
    }
    Some(OwnedHandle(raw))
}

fn cancel_and_wait(pipe: HANDLE, overlapped: &OVERLAPPED) {
    // SAFETY: 取消此 pipe 上的特定 overlapped 操作，並等待核心完成以免堆疊上的 OVERLAPPED 提前釋放。
    unsafe {
        let _ = CancelIoEx(pipe, Some(overlapped));
        let mut unused = 0u32;
        let _ = GetOverlappedResult(pipe, overlapped, &mut unused, true);
    }
}

fn pipe_logger_loop(
    pid: u32,
    stop_handle_val: isize,
    mut first_ready: Option<mpsc::SyncSender<()>>,
) {
    let stop_handle = HANDLE(stop_handle_val as *mut _);
    // SAFETY: 建立此執行緒專用的手動重設 I/O 完成事件。
    let Ok(io_raw) = (unsafe { CreateEventW(None, true, false, None) }) else {
        if let Some(tx) = first_ready.take() {
            let _ = tx.send(());
        }
        return;
    };
    let io_event = OwnedHandle(io_raw);

    loop {
        // SAFETY: stop_handle 在此執行緒結束前均有效。
        if unsafe { WaitForSingleObject(stop_handle, 0) } == WAIT_OBJECT_0 {
            break;
        }
        let Some(pipe) = create_log_pipe(pid) else {
            if let Some(tx) = first_ready.take() {
                let _ = tx.send(());
            }
            break;
        };
        if let Some(tx) = first_ready.take() {
            let _ = tx.send(());
        }

        if !wait_pipe_connect(pipe.0, io_event.0, stop_handle) {
            break;
        }
        if !read_pipe_messages(pipe.0, io_event.0, stop_handle) {
            break;
        }
    }
}

/// 等待 hook 連上 named pipe；回傳 `false` 代表收到停止訊號或不可恢復錯誤，應結束執行緒。
fn wait_pipe_connect(pipe: HANDLE, io_event: HANDLE, stop_event: HANDLE) -> bool {
    // SAFETY: 重設 I/O 事件並發起 Overlapped ConnectNamedPipe。
    unsafe {
        let _ = ResetEvent(io_event);
    }
    let mut overlapped = OVERLAPPED {
        hEvent: io_event,
        ..Default::default()
    };
    // SAFETY: pipe 與 overlapped 在整個等待與取消期間有效。
    if let Err(err) = unsafe { ConnectNamedPipe(pipe, Some(&mut overlapped)) } {
        let code = err.code();
        if code == ERROR_PIPE_CONNECTED.to_hresult() {
            return true;
        }
        if code != ERROR_IO_PENDING.to_hresult() {
            return false;
        }
        let handles = [io_event, stop_event];
        // SAFETY: handles 內兩個事件控制代碼皆有效。
        let wait = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
        if wait != WAIT_OBJECT_0 {
            cancel_and_wait(pipe, &overlapped);
            return false;
        }
        let mut unused = 0u32;
        // SAFETY: io_event 已觸發，查詢連線結果。
        if unsafe { GetOverlappedResult(pipe, &overlapped, &mut unused, false) }.is_err() {
            return false;
        }
    }
    true
}

/// 持續讀取訊息直到客戶端斷線（回傳 `true` 以重建 pipe）或收到 `stop_event`（回傳 `false` 結束執行緒）。
fn read_pipe_messages(pipe: HANDLE, io_event: HANDLE, stop_event: HANDLE) -> bool {
    let mut buf = [0u8; PIPE_BUFFER_SIZE as usize];
    let mut message = Vec::new();
    let handles = [io_event, stop_event];

    loop {
        // SAFETY: 每次讀取前重設手動重設事件。
        unsafe {
            let _ = ResetEvent(io_event);
        }
        let mut overlapped = OVERLAPPED {
            hEvent: io_event,
            ..Default::default()
        };
        // SAFETY: buf 與 overlapped 在此次 I/O 完成或取消前維持有效。
        if let Err(err) = unsafe { ReadFile(pipe, Some(&mut buf), None, Some(&mut overlapped)) } {
            let code = err.code();
            if code != ERROR_IO_PENDING.to_hresult() && code != ERROR_MORE_DATA.to_hresult() {
                return true;
            }
        }

        // SAFETY: 等待讀取完成或停止事件。
        let wait = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
        if wait != WAIT_OBJECT_0 {
            cancel_and_wait(pipe, &overlapped);
            return false;
        }

        let mut bytes = 0u32;
        // SAFETY: io_event 已觸發，取得實際讀取位元組數。
        let res = unsafe { GetOverlappedResult(pipe, &overlapped, &mut bytes, false) };
        let more_data = res
            .as_ref()
            .is_err_and(|err| err.code() == ERROR_MORE_DATA.to_hresult());
        if (res.is_err() && !more_data) || bytes == 0 {
            return true;
        }

        message.extend_from_slice(&buf[..(bytes as usize).min(buf.len())]);
        if !more_data {
            let text = String::from_utf8_lossy(&message);
            let msg = text.trim_end_matches('\0').trim_end();
            eprintln!("[hook] {msg}");
            message.clear();
        }
    }
}

/// 與遊戲內 hook 的一次連線。Drop 時 `SetEvent(stop)` 並關閉 keepalive 與所有控制代碼。
///
/// `CaptureHook_Stop` 是擷取端→hook 的單向訊號（僅於 `Drop` 時觸發）；hook 端重置擷取（`capture_free`）時
/// 會自行 `SetEvent(restart)` 並在下一次 `Present` 重新初始化、再次觸發 `HookReady`，
/// 因此擷取迴圈只需以 `wait_ready(Duration::ZERO)` 輪詢即可偵測重建，遊戲結束則由視窗／程序檢查涵蓋。
pub struct HookSession {
    hwnd: HWND,
    logger: Option<PipeLogger>,
    tex_map: Option<MappedRegion>,
    info_map: MappedRegion,
    #[allow(dead_code)] // 連線期間保持開啟具名事件控制代碼。
    restart: OwnedHandle,
    stop: OwnedHandle,
    #[allow(dead_code)] // 連線期間保持開啟具名事件控制代碼。
    init: OwnedHandle,
    ready: OwnedHandle,
    _keepalive: OwnedHandle,
}

// SAFETY: `HookSession` 內的視窗控制代碼、共享記憶體映射與核心物件皆不在多執行緒間共享，
// 僅隨擷取執行緒生命週期移動與單一執行緒操作。
unsafe impl Send for HookSession {}

impl HookSession {
    /// 取得偏移 → 檢查 keepalive 衝突 → 建立 keepalive → 啟動 log pipe →
    /// 既有 hook 則 SetEvent(restart)，否則以反作弊相容模式注入 → 等 hook 載入 →
    /// 映射並 configure HookInfo → SetEvent(init)、SetEvent(restart)。
    /// `timeout` 涵蓋到 hook 載入為止（不含等待就緒）。
    pub fn attach(
        pid: u32,
        hwnd: HWND,
        files: &HookFiles,
        fps: u32,
        timeout: Duration,
    ) -> Result<Self> {
        let deadline = Instant::now() + timeout;

        // 先檢查 keepalive 是否已被 OBS 或其他程式持有，避免無謂執行外部工具或干擾既有擷取。
        if open_mutex(&protocol::keepalive(pid)).is_some() {
            bail!("hook_unavailable: OBS 或其他程式正在擷取此遊戲");
        }

        let offsets = fetch_offsets(files)?;
        let keepalive = create_keepalive(pid)?;
        let logger = PipeLogger::spawn(pid)?;

        if let Some(existing_restart) = open_event(&protocol::restart(pid)) {
            // SAFETY: existing_restart 為剛開啟的有效事件控制代碼。
            unsafe { SetEvent(existing_restart.0) }
                .context("hook_unavailable: 無法觸發既有 hook 的 Restart 事件")?;
        } else {
            inject_anticheat(hwnd, files)?;
        }

        let tex_mutex_name = protocol::texture_mutex(pid, 1);
        while open_mutex(&tex_mutex_name).is_none() {
            let now = Instant::now();
            if now >= deadline {
                bail!("hook_unavailable: 逾時未載入（可能被反作弊阻擋）");
            }
            thread::sleep(HOOK_LOAD_POLL_INTERVAL.min(deadline - now));
        }

        let info_map = open_map(&protocol::hook_info(pid), size_of::<HookInfo>())
            .context("hook_unavailable: 無法開啟或映射 HookInfo 共享記憶體")?;
        let info_ptr = info_map.as_ptr() as *mut HookInfo;
        // SAFETY: info_ptr 指向 648 bytes 的 HookInfo 共享記憶體（MapViewOfFile 對齊至頁面邊界，滿足 8-byte 對齊）；
        // hook 端只在初始化擷取時寫入自己的欄位，此時尚未觸發 Initialize 事件。
        unsafe {
            let mut info = info_ptr.read_volatile();
            info.configure(offsets, fps);
            ptr::addr_of_mut!((*info_ptr).frame_interval).write_volatile(info.frame_interval);
            ptr::addr_of_mut!((*info_ptr).unused_use_scale).write_volatile(info.unused_use_scale);
            ptr::addr_of_mut!((*info_ptr).force_shmem).write_volatile(info.force_shmem);
            ptr::addr_of_mut!((*info_ptr).capture_overlay).write_volatile(info.capture_overlay);
            ptr::addr_of_mut!((*info_ptr).allow_srgb_alias).write_volatile(info.allow_srgb_alias);
            ptr::addr_of_mut!((*info_ptr).offsets).write_volatile(info.offsets);
        }

        let restart = open_event(&protocol::restart(pid))
            .context("hook_unavailable: 無法開啟 CaptureHook_Restart 事件")?;
        let stop = open_event(&protocol::stop(pid))
            .context("hook_unavailable: 無法開啟 CaptureHook_Stop 事件")?;
        let init = open_event(&protocol::init(pid))
            .context("hook_unavailable: 無法開啟 CaptureHook_Initialize 事件")?;
        let ready = open_event(&protocol::ready(pid))
            .context("hook_unavailable: 無法開啟 CaptureHook_HookReady 事件")?;

        // SAFETY: init 與 restart 為剛開啟的有效事件控制代碼。
        unsafe {
            SetEvent(init.0).context("hook_unavailable: 無法觸發 CaptureHook_Initialize 事件")?;
            SetEvent(restart.0).context("hook_unavailable: 無法觸發 CaptureHook_Restart 事件")?;
        }

        Ok(Self {
            hwnd,
            logger: Some(logger),
            tex_map: None,
            info_map,
            restart,
            stop,
            init,
            ready,
            _keepalive: keepalive,
        })
    }

    /// 等 HookReady（逾時回傳 `Ok(None)`）；就緒時讀 `HookInfo` 與 texture map，回傳材質資訊。
    /// `HookInfo.capture_type` 不是 `TEXTURE`、或格式 `protocol::conversion_for` 不支援 → `hook_unavailable` 錯誤。
    pub fn wait_ready(&mut self, timeout: Duration) -> Result<Option<SharedTexture>> {
        let timeout_ms = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        // SAFETY: self.ready 為有效的事件控制代碼。
        let wait = unsafe { WaitForSingleObject(self.ready.0, timeout_ms) };
        if wait == WAIT_TIMEOUT {
            return Ok(None);
        }
        if wait != WAIT_OBJECT_0 {
            bail!(
                "hook_unavailable: 等待 CaptureHook_HookReady 事件失敗（狀態 0x{:x}）",
                wait.0
            );
        }

        // HookReady 在遊戲改解析度時會再次觸發，先關閉舊的 texture map 再開啟新映射。
        self.tex_map = None;

        let info_ptr = self.info_map.as_ptr() as *const HookInfo;
        // SAFETY: info_ptr 指向 648 bytes 的 HookInfo 共享記憶體；hook 在觸發 HookReady 前已填妥這些欄位，
        // 以 read_volatile 讀取避免編譯器快取跨程序共享記憶體。
        let (capture_type, window, map_id, width, height, format) = unsafe {
            (
                ptr::addr_of!((*info_ptr).capture_type).read_volatile(),
                ptr::addr_of!((*info_ptr).window).read_volatile(),
                ptr::addr_of!((*info_ptr).map_id).read_volatile(),
                ptr::addr_of!((*info_ptr).cx).read_volatile(),
                ptr::addr_of!((*info_ptr).cy).read_volatile(),
                ptr::addr_of!((*info_ptr).format).read_volatile(),
            )
        };

        if CaptureType::from_raw(capture_type) != Some(CaptureType::Texture) {
            bail!("hook_unavailable: hook 未使用共享材質模式（capture_type={capture_type}）");
        }
        if protocol::conversion_for(format).is_none() {
            bail!("hook_unavailable: 不支援的共享材質格式（DXGI_FORMAT={format}）");
        }
        if width == 0 || height == 0 {
            bail!("hook_unavailable: 共享材質尺寸無效（{width}x{height}）");
        }

        let map_name = protocol::texture_map(window, map_id);
        let tex_map = open_map(&map_name, size_of::<u32>())
            .or_else(|| {
                let fallback_window = self.hwnd.0 as usize as u32;
                (fallback_window != 0 && fallback_window != window)
                    .then(|| {
                        open_map(
                            &protocol::texture_map(fallback_window, map_id),
                            size_of::<u32>(),
                        )
                    })
                    .flatten()
            })
            .with_context(|| format!("hook_unavailable: 無法開啟共享材質映射 {map_name}"))?;

        let handle_ptr = tex_map.as_ptr() as *const u32;
        // SAFETY: tex_map 映射至少 4 bytes（shtex_data），第一個 u32 為共享材質 handle。
        let handle = unsafe { handle_ptr.read_volatile() };
        if handle == 0 {
            bail!("hook_unavailable: 共享材質 handle 為 0");
        }
        self.tex_map = Some(tex_map);

        Ok(Some(SharedTexture {
            handle,
            width,
            height,
            format,
        }))
    }
}

impl Drop for HookSession {
    fn drop(&mut self) {
        // SAFETY: 通知遊戲內 hook 停止擷取（DLL 仍留在遊戲內供下次 Restart 沿用）。
        unsafe {
            let _ = SetEvent(self.stop.0);
        }
        // 先停止並等待 log 執行緒結束，其餘映射與控制代碼依欄位順序自動釋放。
        drop(self.logger.take());
    }
}

const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<HookSession>();
};

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R8G8B8A8_UNORM;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE, OPEN_EXISTING,
    };
    use windows::Win32::System::Memory::{CreateFileMappingW, PAGE_READWRITE};

    use super::*;

    static NEXT_TEST_ID: AtomicU32 = AtomicU32::new(1);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "aditorrec-hook-test-{}-{tag}-{id}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write_dummy(&self, name: &str) {
            fs::write(self.0.join(name), b"dummy").unwrap();
        }

        fn write_all_hook_files(&self) {
            for name in [DLL_FILE_NAME, INJECTOR_FILE_NAME, OFFSETS_FILE_NAME] {
                self.write_dummy(name);
            }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn hook_files_requires_all_three_binaries_and_returns_expected_paths() {
        let empty = TempDir::new("empty");
        let err = HookFiles::new(&empty.0).unwrap_err().to_string();
        assert!(err.starts_with("hook_unavailable:"), "{err}");

        for missing in [DLL_FILE_NAME, INJECTOR_FILE_NAME, OFFSETS_FILE_NAME] {
            let partial = TempDir::new("partial");
            for file in [DLL_FILE_NAME, INJECTOR_FILE_NAME, OFFSETS_FILE_NAME] {
                if file != missing {
                    partial.write_dummy(file);
                }
            }
            let err = HookFiles::new(&partial.0).unwrap_err().to_string();
            assert!(err.starts_with("hook_unavailable:"), "{err}");
            assert!(err.contains(missing), "{err}");
        }

        let complete = TempDir::new("complete");
        complete.write_all_hook_files();
        let files = HookFiles::new(&complete.0).unwrap();
        assert_eq!(files.dll(), complete.0.join(DLL_FILE_NAME));
        assert_eq!(files.injector(), complete.0.join(INJECTOR_FILE_NAME));
        assert_eq!(files.offsets_tool(), complete.0.join(OFFSETS_FILE_NAME));
    }

    #[test]
    fn maps_inject_helper_exit_codes_to_hook_unavailable_reasons() {
        assert!(check_inject_exit(Some(0)).is_ok());

        for (code, expected) in [
            (-1, "注入失敗"),
            (-2, "參數錯誤"),
            (-3, "無法開啟程序"),
            (-4, "非預期失敗"),
            (42, "未知錯誤"),
        ] {
            let err = check_inject_exit(Some(code)).unwrap_err().to_string();
            assert!(err.starts_with("hook_unavailable:"), "{err}");
            assert!(err.contains(expected), "{err}");
            assert!(err.contains(&code.to_string()), "{err}");
        }

        let none_err = check_inject_exit(None).unwrap_err().to_string();
        assert!(none_err.starts_with("hook_unavailable:"), "{none_err}");
    }

    #[test]
    fn attach_aborts_before_external_tools_when_keepalive_already_exists() {
        let pid = u32::MAX - 7;
        let keepalive_name = protocol::keepalive(pid);
        // SAFETY: 在測試中先建立假 PID 的 keepalive mutex 模擬 OBS 正在擷取。
        let _obs_keepalive =
            OwnedHandle(unsafe { CreateMutexW(None, false, &wide(&keepalive_name)) }.unwrap());

        let dir = TempDir::new("conflict");
        dir.write_all_hook_files();
        let files = HookFiles::new(&dir.0).unwrap();

        let err = HookSession::attach(pid, HWND::default(), &files, 60, Duration::from_millis(200))
            .err()
            .expect("keepalive 已存在時 attach 應失敗")
            .to_string();
        assert!(err.starts_with("hook_unavailable:"), "{err}");
        assert!(err.contains("OBS"), "{err}");
        assert!(open_event(&protocol::init(pid)).is_none());
    }

    #[test]
    fn pipe_logger_accepts_duplex_client_and_stops_cleanly_on_drop() {
        let pid = u32::MAX - 8;
        let logger = PipeLogger::spawn(pid).unwrap();
        let pipe_name = wide(&protocol::pipe(pid));
        // SAFETY: 比照 graphics-hook 的 ipc_pipe_client_open，以 GENERIC_READ | GENERIC_WRITE 連線。
        let client = OwnedHandle(
            unsafe {
                CreateFileW(
                    &pipe_name,
                    (GENERIC_READ | GENERIC_WRITE).0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    None,
                )
            }
            .unwrap(),
        );
        let payload = b"hook unit test log\0";
        let mut written = 0u32;
        // SAFETY: 寫入測試字串至已連線的 named pipe。
        unsafe {
            WriteFile(client.0, Some(payload), Some(&mut written), None).unwrap();
        }
        assert_eq!(written as usize, payload.len());
        // 客戶端仍連線中直接 drop，驗證 CancelIoEx + stop_event 不會死鎖。
        drop(logger);
    }

    fn create_shared_map(name: &str, size: usize) -> MappedRegion {
        // SAFETY: 測試建立具名頁面檔映射並映射至記憶體。
        unsafe {
            let raw = CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                size as u32,
                &wide(name),
            )
            .unwrap();
            let map = OwnedHandle(raw);
            let view = MapViewOfFile(map.0, FILE_MAP_ALL_ACCESS, 0, 0, size);
            assert!(!view.Value.is_null());
            MappedRegion { view, _map: map }
        }
    }

    fn create_named_event(name: &str) -> OwnedHandle {
        // SAFETY: 測試建立自動重設具名事件。
        OwnedHandle(unsafe { CreateEventW(None, false, false, &wide(name)) }.unwrap())
    }

    #[test]
    fn wait_ready_reads_shared_texture_reopens_on_resize_and_drop_signals_stop() {
        let pid = u32::MAX - 9;
        let game_info = create_shared_map(&protocol::hook_info(pid), size_of::<HookInfo>());
        let game_restart = create_named_event(&protocol::restart(pid));
        let game_stop = create_named_event(&protocol::stop(pid));
        let game_init = create_named_event(&protocol::init(pid));
        let game_ready = create_named_event(&protocol::ready(pid));
        let keepalive = create_keepalive(pid).unwrap();

        let mut session = HookSession {
            hwnd: HWND::default(),
            logger: None,
            tex_map: None,
            info_map: open_map(&protocol::hook_info(pid), size_of::<HookInfo>()).unwrap(),
            restart: open_event(&protocol::restart(pid)).unwrap(),
            stop: open_event(&protocol::stop(pid)).unwrap(),
            init: open_event(&protocol::init(pid)).unwrap(),
            ready: open_event(&protocol::ready(pid)).unwrap(),
            _keepalive: keepalive,
        };

        assert_eq!(session.wait_ready(Duration::ZERO).unwrap(), None);

        let window = 0x1020_3040u32;
        let tex_map_1 = create_shared_map(&protocol::texture_map(window, 1), size_of::<u32>());
        // SAFETY: 寫入模擬的共享材質 handle 與 HookInfo。
        unsafe {
            (tex_map_1.as_ptr() as *mut u32).write_volatile(0xCAFE_BABE);
            (game_info.as_ptr() as *mut HookInfo).write_volatile(HookInfo {
                capture_type: CaptureType::TEXTURE,
                window,
                map_id: 1,
                cx: 3840,
                cy: 2160,
                format: DXGI_FORMAT_R8G8B8A8_UNORM.0 as u32,
                ..HookInfo::default()
            });
            SetEvent(game_ready.0).unwrap();
        }

        assert_eq!(
            session.wait_ready(Duration::from_millis(50)).unwrap(),
            Some(SharedTexture {
                handle: 0xCAFE_BABE,
                width: 3840,
                height: 2160,
                format: DXGI_FORMAT_R8G8B8A8_UNORM.0 as u32,
            })
        );
        // HookReady 為 auto-reset，未再次觸發前輪詢應回傳 None。
        assert_eq!(session.wait_ready(Duration::ZERO).unwrap(), None);

        // 模擬解析度變更：建立新 map_id=2 並再次觸發 HookReady。
        let tex_map_2 = create_shared_map(&protocol::texture_map(window, 2), size_of::<u32>());
        // SAFETY: 更新模擬的 HookInfo 與新 texture map。
        unsafe {
            (tex_map_2.as_ptr() as *mut u32).write_volatile(0xDEAD_BEEF);
            let info_ptr = game_info.as_ptr() as *mut HookInfo;
            ptr::addr_of_mut!((*info_ptr).map_id).write_volatile(2);
            ptr::addr_of_mut!((*info_ptr).cx).write_volatile(2560);
            ptr::addr_of_mut!((*info_ptr).cy).write_volatile(1440);
            SetEvent(game_ready.0).unwrap();
        }
        assert_eq!(
            session.wait_ready(Duration::ZERO).unwrap(),
            Some(SharedTexture {
                handle: 0xDEAD_BEEF,
                width: 2560,
                height: 1440,
                format: DXGI_FORMAT_R8G8B8A8_UNORM.0 as u32,
            })
        );

        // 模擬不支援的 capture_type（共享記憶體）。
        // SAFETY: 修改模擬 HookInfo 的 capture_type 並觸發 HookReady。
        unsafe {
            let info_ptr = game_info.as_ptr() as *mut HookInfo;
            ptr::addr_of_mut!((*info_ptr).capture_type).write_volatile(CaptureType::MEMORY);
            SetEvent(game_ready.0).unwrap();
        }
        let err = session.wait_ready(Duration::ZERO).unwrap_err().to_string();
        assert!(err.starts_with("hook_unavailable:"), "{err}");

        drop(session);
        // Drop 時必須觸發 stop 事件並釋放 keepalive。
        // SAFETY: 檢查 game_stop 是否已被 HookSession::drop 觸發。
        assert_eq!(
            unsafe { WaitForSingleObject(game_stop.0, 0) },
            WAIT_OBJECT_0
        );
        assert!(open_mutex(&protocol::keepalive(pid)).is_none());
        drop((game_restart, game_init));
    }
}
