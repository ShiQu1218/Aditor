//! Feasibility test: capture game frames with the OBS-signed graphics-hook and import them into our D3D11 device with OpenSharedResource.
//! Protocol references for OBS 32.1.2: plugins/win-capture/game-capture.c, graphics-hook/graphics-hook.c,
//! and shared/obs-hook-config/graphics-hook-info.h.
//!
//! Usage: hook_probe <pid> [seconds] [--hook-dir <OBS win-capture directory>] [--direct] [--out <screenshot directory>]
//! Uses anti-cheat-compatible injection by default (SetWindowsHookEx, same as OBS's "Use anti-cheat compatibility hook").

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use windows::core::{Interface, BOOL, HSTRING};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE, HWND, LPARAM, RECT, WAIT_OBJECT_0};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Storage::FileSystem::{ReadFile, PIPE_ACCESS_INBOUND};
use windows::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    MEMORY_MAPPED_VIEW_ADDRESS,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};
use windows::Win32::System::Threading::{
    CreateMutexW, OpenEventW, OpenMutexW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
    SYNCHRONIZATION_SYNCHRONIZE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible,
};

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct GraphicsOffsets {
    d3d8_present: u32,
    d3d9: [u32; 5],
    dxgi_present: u32,
    dxgi_resize: u32,
    dxgi_present1: u32,
    ddraw: [u32; 8],
    dxgi2_release: u32,
    d3d12_execute_command_lists: u32,
}

/// `struct hook_info` from graphics-hook-info.h (#pragma pack(8), matching repr(C) on x64).
#[repr(C)]
struct HookInfo {
    hook_ver_major: u32,
    hook_ver_minor: u32,
    capture_type: u32,
    window: u32,
    format: u32,
    cx: u32,
    cy: u32,
    unused_base_cx: u32,
    unused_base_cy: u32,
    pitch: u32,
    map_id: u32,
    map_size: u32,
    flip: bool,
    frame_interval: u64,
    unused_use_scale: bool,
    force_shmem: bool,
    capture_overlay: bool,
    allow_srgb_alias: bool,
    offsets: GraphicsOffsets,
    reserved: [u32; 126],
}
const _: () = assert!(std::mem::size_of::<HookInfo>() == 648);
const CAPTURE_TYPE_TEXTURE: u32 = 1;

/// Handle to a named kernel object; closed when leaving scope.
struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: Closes only handles opened by this process.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct View(MEMORY_MAPPED_VIEW_ADDRESS);
impl Drop for View {
    fn drop(&mut self) {
        // SAFETY: Unmaps only views created by this process.
        unsafe {
            let _ = UnmapViewOfFile(self.0);
        }
    }
}

fn wide(s: &str) -> HSTRING {
    HSTRING::from(s)
}

fn open_event(name: &str) -> Option<Owned> {
    // SAFETY: Opens only a named event.
    unsafe {
        OpenEventW(
            EVENT_MODIFY_STATE | SYNCHRONIZATION_SYNCHRONIZE,
            false,
            &wide(name),
        )
    }
    .ok()
    .map(Owned)
}

fn open_mutex(name: &str) -> Option<Owned> {
    // SAFETY: Opens only a named mutex.
    unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &wide(name)) }
        .ok()
        .map(Owned)
}

fn open_map(name: &str, size: usize) -> Option<(Owned, View)> {
    // SAFETY: Opens an existing named file mapping and maps the requested size.
    unsafe {
        let handle = OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, &wide(name)).ok()?;
        let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, size);
        if view.Value.is_null() {
            let _ = CloseHandle(handle);
            return None;
        }
        Some((Owned(handle), View(view)))
    }
}

fn signalled(event: &Owned, ms: u32) -> bool {
    // SAFETY: Waits on a valid event handle.
    unsafe { WaitForSingleObject(event.0, ms) == WAIT_OBJECT_0 }
}

struct Search {
    pid: u32,
    best: Option<(HWND, i64)>,
}

unsafe extern "system" fn visit(hwnd: HWND, param: LPARAM) -> BOOL {
    // SAFETY: param is the Search pointer passed by find_window and remains valid during EnumWindows.
    let search = unsafe { &mut *(param.0 as *mut Search) };
    let mut pid = 0;
    let mut rect = RECT::default();
    // SAFETY: Queries window information only.
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == search.pid
            && IsWindowVisible(hwnd).as_bool()
            && GetWindowRect(hwnd, &mut rect).is_ok()
        {
            let area = (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64;
            if search.best.is_none_or(|(_, best)| area > best) {
                search.best = Some((hwnd, area));
            }
        }
    }
    true.into()
}

fn find_window(pid: u32) -> Result<HWND> {
    let mut search = Search { pid, best: None };
    // SAFETY: search remains valid during EnumWindows.
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut _ as isize));
    }
    Ok(search.best.context("No visible window found for the PID")?.0)
}

/// As OBS does, run get-graphics-offsets64.exe and parse its INI-style output.
fn graphics_offsets(dir: &Path) -> Result<GraphicsOffsets> {
    let out = Command::new(dir.join("get-graphics-offsets64.exe"))
        .output()
        .context("Could not run get-graphics-offsets64.exe")?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut section = String::new();
    let mut o = GraphicsOffsets::default();
    for line in text.lines().map(str::trim) {
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = name.to_string();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = u32::from_str_radix(value.trim().trim_start_matches("0x"), 16).unwrap_or(0);
        match (section.as_str(), key.trim()) {
            ("d3d8", "present") => o.d3d8_present = value,
            ("d3d9", "present") => o.d3d9[0] = value,
            ("d3d9", "present_ex") => o.d3d9[1] = value,
            ("d3d9", "present_swap") => o.d3d9[2] = value,
            ("d3d9", "d3d9_clsoff") => o.d3d9[3] = value,
            ("d3d9", "is_d3d9ex_clsoff") => o.d3d9[4] = value,
            ("dxgi", "present") => o.dxgi_present = value,
            ("dxgi", "present1") => o.dxgi_present1 = value,
            ("dxgi", "resize") => o.dxgi_resize = value,
            ("dxgi", "release") => o.dxgi2_release = value,
            _ => {}
        }
    }
    if o.dxgi_present == 0 || o.dxgi_resize == 0 {
        bail!("get-graphics-offsets did not provide DXGI offsets: {text}");
    }
    Ok(o)
}

/// The hook sends NUL-terminated logs through CaptureHook_Pipe{pid}; print them on a background thread.
fn spawn_pipe_logger(pid: u32) {
    std::thread::spawn(move || loop {
        let name = wide(&format!(r"\\.\pipe\CaptureHook_Pipe{pid}"));
        // SAFETY: Create a single-instance, receive-only named pipe; this thread owns the handle.
        let pipe = unsafe {
            CreateNamedPipeW(
                &name,
                PIPE_ACCESS_INBOUND,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                1,
                0,
                64 * 1024,
                0,
                None,
            )
        };
        if pipe.is_invalid() {
            eprintln!("[probe] Could not create hook log pipe");
            return;
        }
        let pipe = Owned(pipe);
        // SAFETY: Blocks while waiting for the hook to connect.
        let _ = unsafe { ConnectNamedPipe(pipe.0, None) };
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let mut read = 0u32;
            // SAFETY: buf remains valid for the duration of the call.
            if unsafe { ReadFile(pipe.0, Some(&mut buf), Some(&mut read), None) }.is_err()
                || read == 0
            {
                break;
            }
            let msg = String::from_utf8_lossy(&buf[..read as usize]);
            println!("[hook] {}", msg.trim_end_matches('\0'));
        }
    });
}

fn bytes_per_pixel(format: DXGI_FORMAT) -> Option<usize> {
    match format {
        DXGI_FORMAT_R8G8B8A8_TYPELESS
        | DXGI_FORMAT_R8G8B8A8_UNORM
        | DXGI_FORMAT_R8G8B8A8_UNORM_SRGB
        | DXGI_FORMAT_B8G8R8A8_TYPELESS
        | DXGI_FORMAT_B8G8R8A8_UNORM
        | DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
        | DXGI_FORMAT_B8G8R8X8_TYPELESS
        | DXGI_FORMAT_B8G8R8X8_UNORM
        | DXGI_FORMAT_R10G10B10A2_TYPELESS
        | DXGI_FORMAT_R10G10B10A2_UNORM => Some(4),
        _ => None,
    }
}

/// Downscaled BGR image: (width, height, pixels).
type SmallImage = (usize, usize, Vec<u8>);

/// Read back one frame: return (average luminance, sample hash, downscaled BGR image). Used only for once-per-second validation.
fn read_back(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
) -> Result<(f64, u64, SmallImage)> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: Reads the texture description.
    unsafe { texture.GetDesc(&mut desc) };
    let bpp =
        bytes_per_pixel(desc.Format).with_context(|| format!("Unsupported format {:?}", desc.Format))?;
    let staging_desc = D3D11_TEXTURE2D_DESC {
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
        ..desc
    };
    let mut staging = None;
    // SAFETY: Creates a staging texture with matching dimensions and format, copies the resource, then maps it for reading.
    unsafe {
        device.CreateTexture2D(&staging_desc, None, Some(&mut staging))?;
        let staging = staging.context("No staging texture returned")?;
        context.CopyResource(&staging, texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let (w, h) = (desc.Width as usize, desc.Height as usize);
        let base = mapped.pData as *const u8;
        let pitch = mapped.RowPitch as usize;
        let ten_bit = matches!(
            desc.Format,
            DXGI_FORMAT_R10G10B10A2_TYPELESS | DXGI_FORMAT_R10G10B10A2_UNORM
        );
        let rgba = matches!(
            desc.Format,
            DXGI_FORMAT_R8G8B8A8_TYPELESS
                | DXGI_FORMAT_R8G8B8A8_UNORM
                | DXGI_FORMAT_R8G8B8A8_UNORM_SRGB
        );
        let pixel = |x: usize, y: usize| -> [u8; 3] {
            let p = base.add(y * pitch + x * bpp);
            if ten_bit {
                let v = (p as *const u32).read_unaligned();
                [
                    ((v >> 22) & 0xff) as u8,
                    ((v >> 12) & 0xff) as u8,
                    ((v >> 2) & 0xff) as u8,
                ]
            } else if rgba {
                [*p.add(2), *p.add(1), *p]
            } else {
                [*p, *p.add(1), *p.add(2)]
            }
        };
        let tw = w.min(960);
        let th = (h * tw / w.max(1)).max(1);
        let mut small = Vec::with_capacity(tw * th * 3);
        let mut sum = 0u64;
        let mut hash = 0xcbf29ce484222325u64;
        for ty in 0..th {
            for tx in 0..tw {
                let px = pixel(tx * w / tw, ty * h / th);
                sum += px.iter().map(|&c| c as u64).sum::<u64>();
                for c in px {
                    hash = (hash ^ c as u64).wrapping_mul(0x100000001b3);
                }
                small.extend_from_slice(&px);
            }
        }
        context.Unmap(&staging, 0);
        Ok((sum as f64 / (tw * th * 3) as f64, hash, (tw, th, small)))
    }
}

/// Save as a 24-bit bottom-up BMP without adding dependencies.
fn save_bmp(path: &Path, (w, h, bgr): &SmallImage) -> Result<()> {
    let row = (w * 3 + 3) & !3;
    let size = 54 + row * h;
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(size as u32).to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(*w as i32).to_le_bytes());
    out.extend_from_slice(&(*h as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&[0; 24]);
    for y in (0..*h).rev() {
        out.extend_from_slice(&bgr[y * w * 3..(y + 1) * w * 3]);
        out.resize(out.len() + row - w * 3, 0);
    }
    std::fs::write(path, out)?;
    Ok(())
}

fn foreground_pid() -> (u32, bool) {
    let mut pid = 0;
    // SAFETY: Queries the foreground window only.
    unsafe {
        let hwnd = GetForegroundWindow();
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        (pid, IsIconic(hwnd).as_bool())
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let pid: u32 = args
        .get(1)
        .context("Usage: hook_probe <pid> [seconds] [--hook-dir DIR] [--direct] [--out DIR]")?
        .parse()?;
    let seconds: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(60);
    let opt = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let hook_dir = PathBuf::from(
        opt("--hook-dir").unwrap_or_else(|| r"D:\obs-studio\data\obs-plugins\win-capture".into()),
    );
    let out_dir = PathBuf::from(opt("--out").unwrap_or_else(|| "hook-probe-shots".into()));
    let direct = args.iter().any(|a| a == "--direct");
    std::fs::create_dir_all(&out_dir)?;

    let hwnd = find_window(pid)?;
    let mut owner = 0;
    // SAFETY: Queries the thread that owns the window.
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner)) };
    println!("[probe] Window 0x{:x}, thread {thread_id}", hwnd.0 as usize);

    let offsets = graphics_offsets(&hook_dir)?;
    println!(
        "[probe] DXGI present=0x{:x} resize=0x{:x}",
        offsets.dxgi_present, offsets.dxgi_resize
    );

    // Keepalive: the hook checks every 5 seconds and stops capture if it no longer exists.
    // SAFETY: Creates a named mutex and closes it when the process exits.
    let _keepalive =
        Owned(unsafe { CreateMutexW(None, false, &wide(&format!("CaptureHook_KeepAlive{pid}")))? });
    spawn_pipe_logger(pid);

    if let Some(restart) = open_event(&format!("CaptureHook_Restart{pid}")) {
        println!("[probe] A hook is already in the game (possibly loaded by OBS); requesting a restart");
        // SAFETY: Valid event handle.
        unsafe { SetEvent(restart.0)? };
    } else {
        let dll = hook_dir.join("graphics-hook64.dll");
        let (mode, id) = if direct { ("0", pid) } else { ("1", thread_id) };
        println!(
            "[probe] Injection ({}): {}",
            if direct { "direct" } else { "anti-cheat-compatible" },
            dll.display()
        );
        let status = Command::new(hook_dir.join("inject-helper64.exe"))
            .arg(&dll)
            .arg(mode)
            .arg(id.to_string())
            .status()
            .context("Could not run inject-helper64.exe")?;
        println!("[probe] inject-helper exit code: {:?}", status.code());
        if !status.success() {
            bail!("Injection failed (exit code {:?})", status.code());
        }
    }

    // Anti-cheat-compatible injection waits for the game thread to process messages before loading the DLL; check whether the texture mutex exists.
    let deadline = Instant::now() + Duration::from_secs(15);
    while open_mutex(&format!("CaptureHook_TextureMutex1{pid}")).is_none() {
        if Instant::now() > deadline {
            bail!("Hook did not load within 15 seconds (it may have been blocked by anti-cheat, or the game window may not be processing messages)");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("[probe] Hook loaded");

    let (_info_map, info_view) =
        open_map(&format!("CaptureHook_HookInfo{pid}"), 648).context("Could not open hook_info")?;
    let info = info_view.0.Value as *mut HookInfo;
    // SAFETY: info points to 648 bytes of shared memory matching hook_info; the hook writes only during capture initialization.
    unsafe {
        (*info).offsets = offsets;
        (*info).capture_overlay = false;
        (*info).force_shmem = false;
        (*info).unused_use_scale = false;
        (*info).allow_srgb_alias = true;
        (*info).frame_interval = 1_000_000_000 / 120;
    }
    let event = |name: &str| {
        open_event(&format!("{name}{pid}")).with_context(|| format!("Could not open event {name}"))
    };
    let restart = event("CaptureHook_Restart")?;
    let stop = event("CaptureHook_Stop")?;
    let init = event("CaptureHook_Initialize")?;
    let ready = event("CaptureHook_HookReady")?;
    // SAFETY: Valid event handle.
    unsafe {
        SetEvent(init.0)?;
        SetEvent(restart.0)?;
    }
    println!("[probe] Initialization sent; waiting for the game's next Present...");
    if !signalled(&ready, 15_000) {
        bail!("Hook did not report readiness within 15 seconds (the game may not have presented a frame, or DX12 hooking may have failed; see the [hook] log above)");
    }

    // SAFETY: hook_info is populated after the hook reports readiness.
    let (hook_ver, kind, window, map_id, cx, cy, format) = unsafe {
        (
            (*info).hook_ver_major,
            (*info).capture_type,
            (*info).window,
            (*info).map_id,
            (*info).cx,
            (*info).cy,
            (*info).format,
        )
    };
    println!("[probe] Hook {hook_ver}.x ready: {cx}x{cy}, format {format}, type {kind}");
    if kind != CAPTURE_TYPE_TEXTURE {
        bail!("The hook selected shared-memory mode (not a shared texture); this test validates shared textures only");
    }
    let (_tex_map, tex_view) = open_map(&format!("CaptureHook_Texture_{window}_{map_id}"), 4)
        .context("Could not open shared texture metadata")?;
    // SAFETY: shtex_data contains only one u32.
    let tex_handle = unsafe { *(tex_view.0.Value as *const u32) };

    let mut device = None;
    let mut context = None;
    // SAFETY: Creates a device on the default hardware adapter.
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    let device = device.context("No device returned")?;
    let context = context.context("No context returned")?;
    // SAFETY: Query the adapter name to confirm it matches the game's GPU.
    unsafe {
        let adapter = device.cast::<IDXGIDevice>()?.GetAdapter()?.GetDesc()?;
        let name = String::from_utf16_lossy(&adapter.Description);
        println!("[probe] Our device: {}", name.trim_end_matches('\0'));
    }
    let mut texture: Option<ID3D11Texture2D> = None;
    // SAFETY: Opens the legacy shared handle (D3D11_RESOURCE_MISC_SHARED) with OpenSharedResource.
    unsafe { device.OpenSharedResource(HANDLE(tex_handle as usize as *mut _), &mut texture) }
        .context("OpenSharedResource failed (the game may be using a different GPU)")?;
    let texture = texture.context("No shared texture returned")?;
    println!("[probe] Shared texture opened; starting {seconds}-second validation (one readback per second)");

    let mut last_hash = 0;
    for second in 1..=seconds {
        std::thread::sleep(Duration::from_secs(1));
        if signalled(&stop, 0) {
            println!("[probe] Hook sent the stop signal");
            break;
        }
        let (fg, iconic) = foreground_pid();
        let (luma, hash, small) = read_back(&device, &context, &texture)?;
        let changed = hash != last_hash;
        last_hash = hash;
        println!(
            "[probe] {second:>3}s luminance {luma:>6.1} {} game {}{}",
            if changed {
                "frame changed"
            } else {
                "unchanged"
            },
            if fg == pid { "foreground" } else { "background" },
            if iconic { " (minimized)" } else { "" }
        );
        if second % 5 == 0 {
            save_bmp(&out_dir.join(format!("shot_{second:03}.bmp")), &small)?;
        }
        let _ = std::io::stdout().flush();
    }
    // SAFETY: Valid event; tell the hook to stop capture (the DLL remains in the game for reuse).
    unsafe {
        let _ = SetEvent(stop.0);
    }
    println!("[probe] Finished; screenshots are in {}", out_dir.display());
    Ok(())
}
