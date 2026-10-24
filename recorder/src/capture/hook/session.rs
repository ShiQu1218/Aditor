//! OBS graphics-hook injection, shared-memory initialization, readiness waiting, and diagnostic log pipe.
//! References OBS 32.1.2 implementation files for game capture, graphics hook, pipe I/O, and library injection.
//! References OBS 32.1.2 pipe-windows.c and inject-library.h implementation files.

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

/// Anti-cheat-compatible injection waits for the game window thread to process messages before the DLL loads; poll every 100 ms.
const HOOK_LOAD_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// Matches the OBS IPC_PIPE_BUF_SIZE constant.
const PIPE_BUFFER_SIZE: u32 = 1024;

/// Directory containing hook files; construction verifies that all three files exist.
#[derive(Debug, Clone)]
pub struct HookFiles {
    dir: PathBuf,
}

impl HookFiles {
    pub fn new(dir: impl Into<PathBuf>) -> Result<Self> {
        let files = Self { dir: dir.into() };
        for path in [files.dll(), files.injector(), files.offsets_tool()] {
            if !path.is_file() {
                bail!("hook_unavailable: Hook file not found {}", path.display());
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

/// Shared-texture information reported after the hook becomes ready.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SharedTexture {
    pub handle: u32,
    pub width: u32,
    pub height: u32,
    pub format: u32,
}

/// Named kernel-object handle; automatically closed when it leaves scope.
struct OwnedHandle(HANDLE);

// SAFETY: Win32 kernel handles are process-scoped and can be transferred, used, and closed on another thread.
// Handles are not tied to their creating thread and may be transferred, used, and closed by another thread.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: Closes only a valid handle exclusively owned by this structure.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// Mapped file region; unmap it before closing the file-mapping handle on drop.
struct MappedRegion {
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    _map: OwnedHandle,
}

// SAFETY: The mapped shared-memory pointer is valid for all process threads and exclusively owned by HookSession.
// HookSession exclusively owns the mapping; it is never accessed concurrently across threads.
unsafe impl Send for MappedRegion {}

impl MappedRegion {
    fn as_ptr(&self) -> *mut u8 {
        self.view.Value as *mut u8
    }
}

impl Drop for MappedRegion {
    fn drop(&mut self) {
        if !self.view.Value.is_null() {
            // SAFETY: view was created by MapViewOfFile in open_map and is unmapped here exactly once.
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
    // SAFETY: Opens an existing kernel event by name only.
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
    // SAFETY: Opens an existing kernel event by name only.
    unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &wide(name)) }
        .ok()
        .map(OwnedHandle)
}

fn open_map(name: &str, size: usize) -> Option<MappedRegion> {
    // SAFETY: Opens an existing named file mapping and maps the requested byte count; closes the handle immediately on failure.
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

/// Matches the OBS IPC_PIPE_BUF_SIZE constant.
fn inject_code_reason(code: i32) -> &'static str {
    match code {
        0 => "Success",
        -1 => "Injection failed",
        -2 => "Invalid arguments",
        -3 => "Could not open process",
        -4 => "Unexpected failure",
        _ => "Unknown error",
    }
}

/// Checks the helper exit code and maps nonzero codes to hook_unavailable errors.
fn check_inject_exit(code: Option<i32>) -> Result<()> {
    match code {
        Some(0) => Ok(()),
        Some(code) => bail!(
            "hook_unavailable: inject-helper64.exe {} (exit code {code})",
            inject_code_reason(code)
        ),
        None => {
            bail!("hook_unavailable: inject-helper64.exe terminated unexpectedly (no exit code)")
        }
    }
}

fn fetch_offsets(files: &HookFiles) -> Result<GraphicsOffsets> {
    let output = Command::new(files.offsets_tool())
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .context("hook_unavailable: Failed to run get-graphics-offsets64.exe")?;
    if !output.status.success() {
        bail!(
            "hook_unavailable: get-graphics-offsets64.exe failed (exit code {:?})",
            output.status.code()
        );
    }
    let text = String::from_utf8_lossy(&output.stdout);
    protocol::parse_offsets(&text)
        .map_err(|err| anyhow::anyhow!("hook_unavailable: Failed to parse graphics offsets：{err}"))
}

fn create_keepalive(pid: u32) -> Result<OwnedHandle> {
    let name = protocol::keepalive(pid);
    if open_mutex(&name).is_some() {
        bail!("hook_unavailable: OBS or another application is already capturing this game");
    }
    // SAFETY: Creates a named mutex, then checks ERROR_ALREADY_EXISTS to prevent races.
    let raw = unsafe { CreateMutexW(None, false, &wide(&name)) }
        .context("hook_unavailable: Failed to create keepalive mutex")?;
    let handle = OwnedHandle(raw);
    // SAFETY: CreateMutexW returns a handle even if the mutex exists; windows-rs does not overwrite last error on success,
    // so GetLastError reliably detects ERROR_ALREADY_EXISTS here.
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        bail!("hook_unavailable: OBS or another application is already capturing this game");
    }
    Ok(handle)
}

fn inject_anticheat(hwnd: HWND, files: &HookFiles) -> Result<()> {
    let mut window_pid = 0u32;
    // SAFETY: Queries only the window thread ID and does not open a process handle.
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut window_pid)) };
    if thread_id == 0 {
        bail!("hook_unavailable: Failed to get the game window thread ID");
    }
    let dll = std::path::absolute(files.dll()).unwrap_or_else(|_| files.dll());
    let status = Command::new(files.injector())
        .creation_flags(CREATE_NO_WINDOW.0)
        .arg(&dll)
        .arg("1")
        .arg(thread_id.to_string())
        .status()
        .context("hook_unavailable: Failed to run inject-helper64.exe")?;
    check_inject_exit(status.code())
}

/// Background thread receives diagnostic messages from the hook named pipe.
/// Uses overlapped I/O and a manual-reset stop event to cancel blocked pipe I/O on Drop and avoid orphaned threads.
/// Drop can wake and cancel I/O blocked in ConnectNamedPipe or ReadFile immediately, preventing an orphaned thread.
struct PipeLogger {
    stop_event: OwnedHandle,
    worker: Option<JoinHandle<()>>,
}

impl PipeLogger {
    fn spawn(pid: u32) -> Result<Self> {
        // SAFETY: Creates a manual-reset event to signal the log thread to stop.
        let stop_raw = unsafe { CreateEventW(None, true, false, None) }
            .context("hook_unavailable: Failed to create log-pipe stop event")?;
        let stop_event = OwnedHandle(stop_raw);
        // Passes the stop-event handle value to the worker; PipeLogger::drop joins it before closing the handle.
        let stop_handle_val = stop_event.0 .0 as isize;
        let (bound_tx, bound_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("aditorrec-hook-log".into())
            .spawn(move || {
                pipe_logger_loop(pid, stop_handle_val, Some(bound_tx));
            })
            .context("hook_unavailable: Failed to start log-pipe thread")?;
        // Waits for pipe creation so the hook can connect when Restart is triggered.
        let _ = bound_rx.recv();
        Ok(Self {
            stop_event,
            worker: Some(worker),
        })
    }
}

impl Drop for PipeLogger {
    fn drop(&mut self) {
        // SAFETY: stop_event remains valid until the worker joins.
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
    // SAFETY: Creates a named mutex, then checks ERROR_ALREADY_EXISTS to prevent races.
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
    // SAFETY: Cancels the selected overlapped pipe operation and waits before freeing stack OVERLAPPED data.
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
    // SAFETY: Creates a named mutex, then checks ERROR_ALREADY_EXISTS to prevent races.
    let Ok(io_raw) = (unsafe { CreateEventW(None, true, false, None) }) else {
        if let Some(tx) = first_ready.take() {
            let _ = tx.send(());
        }
        return;
    };
    let io_event = OwnedHandle(io_raw);

    loop {
        // SAFETY: stop_event remains valid until the worker joins.
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

/// Waits for the hook to connect; false indicates stop or an unrecoverable error.
fn wait_pipe_connect(pipe: HANDLE, io_event: HANDLE, stop_event: HANDLE) -> bool {
    // SAFETY: Resets the I/O event and starts an overlapped pipe connection.
    unsafe {
        let _ = ResetEvent(io_event);
    }
    let mut overlapped = OVERLAPPED {
        hEvent: io_event,
        ..Default::default()
    };
    // SAFETY: pipe and overlapped remain valid throughout the wait and cancellation.
    if let Err(err) = unsafe { ConnectNamedPipe(pipe, Some(&mut overlapped)) } {
        let code = err.code();
        if code == ERROR_PIPE_CONNECTED.to_hresult() {
            return true;
        }
        if code != ERROR_IO_PENDING.to_hresult() {
            return false;
        }
        let handles = [io_event, stop_event];
        // SAFETY: Both event handles are valid.
        let wait = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
        if wait != WAIT_OBJECT_0 {
            cancel_and_wait(pipe, &overlapped);
            return false;
        }
        let mut unused = 0u32;
        // SAFETY: io_event was signaled; query the result.
        if unsafe { GetOverlappedResult(pipe, &overlapped, &mut unused, false) }.is_err() {
            return false;
        }
    }
    true
}

/// Reads until the client disconnects (recreate the pipe) or stop_event is signaled (exit the thread).
fn read_pipe_messages(pipe: HANDLE, io_event: HANDLE, stop_event: HANDLE) -> bool {
    let mut buf = [0u8; PIPE_BUFFER_SIZE as usize];
    let mut message = Vec::new();
    let handles = [io_event, stop_event];

    loop {
        // SAFETY: Resets the manual-reset event before each read.
        unsafe {
            let _ = ResetEvent(io_event);
        }
        let mut overlapped = OVERLAPPED {
            hEvent: io_event,
            ..Default::default()
        };
        // SAFETY: buf and overlapped remain valid until this I/O completes or is cancelled.
        if let Err(err) = unsafe { ReadFile(pipe, Some(&mut buf), None, Some(&mut overlapped)) } {
            let code = err.code();
            if code != ERROR_IO_PENDING.to_hresult() && code != ERROR_MORE_DATA.to_hresult() {
                return true;
            }
        }

        // SAFETY: Waits for the read to finish or the stop event.
        let wait = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
        if wait != WAIT_OBJECT_0 {
            cancel_and_wait(pipe, &overlapped);
            return false;
        }

        let mut bytes = 0u32;
        // SAFETY: io_event was signaled; query the result.
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

/// One connection to the in-game hook. Drop signals stop and closes keepalive and all handles.
///
/// CaptureHook_Stop is a one-way signal from capture to the hook, sent only on Drop; when the hook resets capture,
/// the hook signals restart, reinitializes on the next Present, and signals HookReady again,
/// so the capture loop polls wait_ready(Duration::ZERO) for recreation; window/process checks detect game exit.
pub struct HookSession {
    hwnd: HWND,
    logger: Option<PipeLogger>,
    tex_map: Option<MappedRegion>,
    info_map: MappedRegion,
    #[allow(dead_code)] // Keeps the named event handle open for the duration of the connection.
    restart: OwnedHandle,
    stop: OwnedHandle,
    #[allow(dead_code)] // Keeps the named event handle open for the duration of the connection.
    init: OwnedHandle,
    ready: OwnedHandle,
    _keepalive: OwnedHandle,
}

// SAFETY: HookSession handles, shared-memory mapping, and kernel objects are not shared across threads,
// and move with the capture-thread lifetime for single-threaded access.
unsafe impl Send for HookSession {}

impl HookSession {
    /// Gets offsets, checks keepalive conflicts, starts the log pipe, and restarts or injects the hook.
    /// Waits for hook loading, maps and configures HookInfo, then signals initialization and restart.
    /// Maps and configures HookInfo, then signals initialization and restart.
    /// timeout covers hook loading but not readiness waiting.
    pub fn attach(
        pid: u32,
        hwnd: HWND,
        files: &HookFiles,
        fps: u32,
        timeout: Duration,
    ) -> Result<Self> {
        let deadline = Instant::now() + timeout;

        // Checks whether OBS or another application holds keepalive before running external tools.
        if open_mutex(&protocol::keepalive(pid)).is_some() {
            bail!("hook_unavailable: OBS or another application is already capturing this game");
        }

        let offsets = fetch_offsets(files)?;
        let keepalive = create_keepalive(pid)?;
        let logger = PipeLogger::spawn(pid)?;

        if let Some(existing_restart) = open_event(&protocol::restart(pid)) {
            // SAFETY: existing_restart is a valid event handle just opened.
            unsafe { SetEvent(existing_restart.0) }
                .context("hook_unavailable: Failed to signal the existing hook Restart event")?;
        } else {
            inject_anticheat(hwnd, files)?;
        }

        let tex_mutex_name = protocol::texture_mutex(pid, 1);
        while open_mutex(&tex_mutex_name).is_none() {
            let now = Instant::now();
            if now >= deadline {
                bail!("hook_unavailable: Timed out waiting for the hook to load (possibly blocked by anti-cheat)");
            }
            thread::sleep(HOOK_LOAD_POLL_INTERVAL.min(deadline - now));
        }

        let info_map = open_map(&protocol::hook_info(pid), size_of::<HookInfo>())
            .context("hook_unavailable: Failed to open or map HookInfo shared memory")?;
        let info_ptr = info_map.as_ptr() as *mut HookInfo;
        // SAFETY: info_ptr points to 648 bytes of HookInfo shared memory aligned to an 8-byte boundary;
        // the hook writes its fields during capture initialization, before Initialize is signaled.
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
            .context("hook_unavailable: Failed to open CaptureHook_Restart event")?;
        let stop = open_event(&protocol::stop(pid))
            .context("hook_unavailable: Failed to open CaptureHook_Stop event")?;
        let init = open_event(&protocol::init(pid))
            .context("hook_unavailable: Failed to open CaptureHook_Initialize event")?;
        let ready = open_event(&protocol::ready(pid))
            .context("hook_unavailable: Failed to open CaptureHook_HookReady event")?;

        // SAFETY: init and restart are valid event handles just opened.
        unsafe {
            SetEvent(init.0)
                .context("hook_unavailable: Failed to signal CaptureHook_Initialize event")?;
            SetEvent(restart.0)
                .context("hook_unavailable: Failed to signal CaptureHook_Restart event")?;
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

    /// Waits for HookReady (timeout returns Ok(None)); when ready, reads HookInfo and the texture map.
    /// Returns hook_unavailable if capture_type is not TEXTURE or the format is unsupported.
    pub fn wait_ready(&mut self, timeout: Duration) -> Result<Option<SharedTexture>> {
        let timeout_ms = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        // SAFETY: self.ready is a valid event handle.
        let wait = unsafe { WaitForSingleObject(self.ready.0, timeout_ms) };
        if wait == WAIT_TIMEOUT {
            return Ok(None);
        }
        if wait != WAIT_OBJECT_0 {
            bail!(
                "hook_unavailable: Failed while waiting for CaptureHook_HookReady event(status 0x{:x}",
                wait.0
            );
        }

        // HookReady may signal again on resolution changes; close the old texture map before opening the new one.
        self.tex_map = None;

        let info_ptr = self.info_map.as_ptr() as *const HookInfo;
        // SAFETY: info_ptr points to 648 bytes of HookInfo shared memory aligned to an 8-byte boundary;
        // read_volatile prevents compiler caching of inter-process shared memory.
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
            bail!("hook_unavailable: Hook is not using shared-texture mode (capture_type={capture_type})");
        }
        if protocol::conversion_for(format).is_none() {
            bail!("hook_unavailable: Unsupported shared texture format (DXGI_FORMAT={format})");
        }
        if width == 0 || height == 0 {
            bail!("hook_unavailable: Invalid shared texture dimensions ({width}x{height})");
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
            .with_context(|| {
                format!("hook_unavailable: Failed to open shared-texture mapping {map_name}")
            })?;

        let handle_ptr = tex_map.as_ptr() as *const u32;
        // SAFETY: tex_map maps at least four bytes; the first u32 is the shared-texture handle.
        let handle = unsafe { handle_ptr.read_volatile() };
        if handle == 0 {
            bail!("hook_unavailable: Shared texture handle is 0");
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
        // SAFETY: Signals the in-game hook to stop capture; its DLL remains loaded for a later Restart.
        unsafe {
            let _ = SetEvent(self.stop.0);
        }
        // Stops and joins the log thread before releasing other mappings and handles.
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
            (-1, "Injection failed"),
            (-2, "Invalid arguments"),
            (-3, "Could not open process"),
            (-4, "Unexpected failure"),
            (42, "Unknown error"),
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
        // SAFETY: Creates a fake-PID keepalive mutex in the test to simulate OBS capture.
        let _obs_keepalive =
            OwnedHandle(unsafe { CreateMutexW(None, false, &wide(&keepalive_name)) }.unwrap());

        let dir = TempDir::new("conflict");
        dir.write_all_hook_files();
        let files = HookFiles::new(&dir.0).unwrap();

        let err = HookSession::attach(pid, HWND::default(), &files, 60, Duration::from_millis(200))
            .err()
            .expect("attach should fail when keepalive already exists")
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
        // SAFETY: Connects with GENERIC_READ | GENERIC_WRITE, matching the hook pipe client.
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
        // SAFETY: Writes test data to the connected named pipe.
        unsafe {
            WriteFile(client.0, Some(payload), Some(&mut written), None).unwrap();
        }
        assert_eq!(written as usize, payload.len());
        // Drops while the client remains connected to verify cancellation does not deadlock.
        drop(logger);
    }

    fn create_shared_map(name: &str, size: usize) -> MappedRegion {
        // SAFETY: Creates and maps a named page-file mapping for the test.
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
        // SAFETY: Creates and maps a named page-file mapping for the test.
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
        // SAFETY: Writes test data to the connected named pipe.
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
        // HookReady may signal again on resolution changes; close the old texture map before opening the new one.
        assert_eq!(session.wait_ready(Duration::ZERO).unwrap(), None);

        // Simulate a resolution change by creating map_id=2 and signaling HookReady again.
        let tex_map_2 = create_shared_map(&protocol::texture_map(window, 2), size_of::<u32>());
        // SAFETY: Updates the simulated HookInfo and texture map.
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

        // Simulate an unsupported capture_type (shared memory).
        // SAFETY: Changes the simulated capture_type and signals HookReady.
        unsafe {
            let info_ptr = game_info.as_ptr() as *mut HookInfo;
            ptr::addr_of_mut!((*info_ptr).capture_type).write_volatile(CaptureType::MEMORY);
            SetEvent(game_ready.0).unwrap();
        }
        let err = session.wait_ready(Duration::ZERO).unwrap_err().to_string();
        assert!(err.starts_with("hook_unavailable:"), "{err}");

        drop(session);
        // Drop must signal the stop event and release keepalive.
        // SAFETY: Checks whether HookSession::drop signaled game_stop.
        assert_eq!(
            unsafe { WaitForSingleObject(game_stop.0, 0) },
            WAIT_OBJECT_0
        );
        assert!(open_mutex(&protocol::keepalive(pid)).is_none());
        drop((game_restart, game_init));
    }
}
