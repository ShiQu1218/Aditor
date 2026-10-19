//! 可行性驗證：以 OBS 官方簽章的 graphics-hook 擷取遊戲畫面，經 OpenSharedResource 收進我們的 D3D11 裝置。
//! 協定對照 OBS 32.1.2：plugins/win-capture/game-capture.c、graphics-hook/graphics-hook.c、
//! shared/obs-hook-config/graphics-hook-info.h。
//!
//! 用法：hook_probe <pid> [秒數] [--hook-dir <OBS win-capture 目錄>] [--direct] [--out <截圖目錄>]
//! 預設用反作弊相容注入（SetWindowsHookEx，與 OBS「使用反作弊相容掛鉤」相同）。

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

/// graphics-hook-info.h 的 `struct hook_info`（#pragma pack(8)，x64 與 repr(C) 相同）。
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

/// 具名核心物件的控制代碼，離開作用域時關閉。
struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: 只關閉本程式開啟的控制代碼。
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct View(MEMORY_MAPPED_VIEW_ADDRESS);
impl Drop for View {
    fn drop(&mut self) {
        // SAFETY: 只解除本程式建立的 view。
        unsafe {
            let _ = UnmapViewOfFile(self.0);
        }
    }
}

fn wide(s: &str) -> HSTRING {
    HSTRING::from(s)
}

fn open_event(name: &str) -> Option<Owned> {
    // SAFETY: 只開啟具名事件。
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
    // SAFETY: 只開啟具名 mutex。
    unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &wide(name)) }
        .ok()
        .map(Owned)
}

fn open_map(name: &str, size: usize) -> Option<(Owned, View)> {
    // SAFETY: 開啟既有的具名 file mapping 並映射指定大小。
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
    // SAFETY: 等待有效的事件控制代碼。
    unsafe { WaitForSingleObject(event.0, ms) == WAIT_OBJECT_0 }
}

struct Search {
    pid: u32,
    best: Option<(HWND, i64)>,
}

unsafe extern "system" fn visit(hwnd: HWND, param: LPARAM) -> BOOL {
    // SAFETY: param 是 find_window 傳入的 Search 指標，EnumWindows 期間有效。
    let search = unsafe { &mut *(param.0 as *mut Search) };
    let mut pid = 0;
    let mut rect = RECT::default();
    // SAFETY: 只查詢視窗資訊。
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
    // SAFETY: search 在 EnumWindows 期間有效。
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut _ as isize));
    }
    Ok(search.best.context("找不到該 PID 的可見視窗")?.0)
}

/// 與 OBS 相同：執行 get-graphics-offsets64.exe，解析 ini 格式的輸出。
fn graphics_offsets(dir: &Path) -> Result<GraphicsOffsets> {
    let out = Command::new(dir.join("get-graphics-offsets64.exe"))
        .output()
        .context("無法執行 get-graphics-offsets64.exe")?;
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
        bail!("get-graphics-offsets 沒有給出 DXGI 偏移：{text}");
    }
    Ok(o)
}

/// hook 透過 CaptureHook_Pipe{pid} 送出以 NUL 結尾的 log 字串；在背景執行緒印出。
fn spawn_pipe_logger(pid: u32) {
    std::thread::spawn(move || loop {
        let name = wide(&format!(r"\\.\pipe\CaptureHook_Pipe{pid}"));
        // SAFETY: 建立單一實例、只收訊息的 named pipe；控制代碼由本執行緒擁有。
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
            eprintln!("[probe] 無法建立 hook log pipe");
            return;
        }
        let pipe = Owned(pipe);
        // SAFETY: 阻塞等待 hook 連線。
        let _ = unsafe { ConnectNamedPipe(pipe.0, None) };
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let mut read = 0u32;
            // SAFETY: buf 在呼叫期間有效。
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

/// 縮小的 BGR 影像：(寬, 高, 像素)。
type SmallImage = (usize, usize, Vec<u8>);

/// 讀回一格：回傳 (亮度平均, 抽樣雜湊, 縮小的 BGR 影像)。只在每秒一次的驗證中使用。
fn read_back(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
) -> Result<(f64, u64, SmallImage)> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: 讀取描述。
    unsafe { texture.GetDesc(&mut desc) };
    let bpp =
        bytes_per_pixel(desc.Format).with_context(|| format!("不支援的格式 {:?}", desc.Format))?;
    let staging_desc = D3D11_TEXTURE2D_DESC {
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
        ..desc
    };
    let mut staging = None;
    // SAFETY: 建立同尺寸同格式的 staging，複製後映射讀取。
    unsafe {
        device.CreateTexture2D(&staging_desc, None, Some(&mut staging))?;
        let staging = staging.context("沒有 staging")?;
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

/// 存成 24-bit BMP（由下而上），避免額外相依。
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
    // SAFETY: 只查詢前景視窗。
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
        .context("用法：hook_probe <pid> [秒數] [--hook-dir 目錄] [--direct] [--out 目錄]")?
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
    // SAFETY: 查詢視窗所屬執行緒。
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner)) };
    println!("[probe] 視窗 0x{:x}，執行緒 {thread_id}", hwnd.0 as usize);

    let offsets = graphics_offsets(&hook_dir)?;
    println!(
        "[probe] DXGI present=0x{:x} resize=0x{:x}",
        offsets.dxgi_present, offsets.dxgi_resize
    );

    // keepalive：hook 每 5 秒檢查一次，不存在就停止擷取。
    // SAFETY: 建立具名 mutex，程式結束時關閉。
    let _keepalive =
        Owned(unsafe { CreateMutexW(None, false, &wide(&format!("CaptureHook_KeepAlive{pid}")))? });
    spawn_pipe_logger(pid);

    if let Some(restart) = open_event(&format!("CaptureHook_Restart{pid}")) {
        println!("[probe] 遊戲裡已有 hook（可能是 OBS 載入的），直接要求重新開始");
        // SAFETY: 有效事件。
        unsafe { SetEvent(restart.0)? };
    } else {
        let dll = hook_dir.join("graphics-hook64.dll");
        let (mode, id) = if direct { ("0", pid) } else { ("1", thread_id) };
        println!(
            "[probe] 注入（{}）：{}",
            if direct { "直接" } else { "反作弊相容" },
            dll.display()
        );
        let status = Command::new(hook_dir.join("inject-helper64.exe"))
            .arg(&dll)
            .arg(mode)
            .arg(id.to_string())
            .status()
            .context("無法執行 inject-helper64.exe")?;
        println!("[probe] inject-helper 結束碼 {:?}", status.code());
        if !status.success() {
            bail!("注入失敗（結束碼 {:?}）", status.code());
        }
    }

    // 反作弊相容注入要等遊戲執行緒處理訊息才會載入 DLL；以 texture mutex 是否存在判斷。
    let deadline = Instant::now() + Duration::from_secs(15);
    while open_mutex(&format!("CaptureHook_TextureMutex1{pid}")).is_none() {
        if Instant::now() > deadline {
            bail!("15 秒內 hook 沒有載入（可能被反作弊擋下，或遊戲視窗沒有在處理訊息）");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("[probe] hook 已載入");

    let (_info_map, info_view) =
        open_map(&format!("CaptureHook_HookInfo{pid}"), 648).context("無法開啟 hook_info")?;
    let info = info_view.0.Value as *mut HookInfo;
    // SAFETY: info 指向 648 bytes 的共享記憶體，佈局與 hook_info 相同；hook 端只在初始化擷取時寫入。
    unsafe {
        (*info).offsets = offsets;
        (*info).capture_overlay = false;
        (*info).force_shmem = false;
        (*info).unused_use_scale = false;
        (*info).allow_srgb_alias = true;
        (*info).frame_interval = 1_000_000_000 / 120;
    }
    let event = |name: &str| {
        open_event(&format!("{name}{pid}")).with_context(|| format!("無法開啟事件 {name}"))
    };
    let restart = event("CaptureHook_Restart")?;
    let stop = event("CaptureHook_Stop")?;
    let init = event("CaptureHook_Initialize")?;
    let ready = event("CaptureHook_HookReady")?;
    // SAFETY: 有效事件。
    unsafe {
        SetEvent(init.0)?;
        SetEvent(restart.0)?;
    }
    println!("[probe] 已送出初始化，等待遊戲下一次 Present……");
    if !signalled(&ready, 15_000) {
        bail!("15 秒內 hook 沒有回報就緒（遊戲沒有 Present，或 DX12 掛鉤失敗；請看上面的 [hook] log）");
    }

    // SAFETY: hook 回報就緒後 hook_info 已填好。
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
    println!("[probe] hook {hook_ver}.x 就緒：{cx}x{cy} 格式 {format} 類型 {kind}");
    if kind != CAPTURE_TYPE_TEXTURE {
        bail!("hook 選擇了共享記憶體模式（非共享材質）；這個測試只驗證共享材質");
    }
    let (_tex_map, tex_view) = open_map(&format!("CaptureHook_Texture_{window}_{map_id}"), 4)
        .context("無法開啟共享材質資訊")?;
    // SAFETY: shtex_data 只有一個 u32。
    let tex_handle = unsafe { *(tex_view.0.Value as *const u32) };

    let mut device = None;
    let mut context = None;
    // SAFETY: 在預設硬體轉接器建立裝置。
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
    let device = device.context("沒有裝置")?;
    let context = context.context("沒有 context")?;
    // SAFETY: 查詢轉接器名稱供確認與遊戲同一張顯示卡。
    unsafe {
        let adapter = device.cast::<IDXGIDevice>()?.GetAdapter()?.GetDesc()?;
        let name = String::from_utf16_lossy(&adapter.Description);
        println!("[probe] 我們的裝置：{}", name.trim_end_matches('\0'));
    }
    let mut texture: Option<ID3D11Texture2D> = None;
    // SAFETY: 舊式共享 handle（D3D11_RESOURCE_MISC_SHARED），以 OpenSharedResource 開啟。
    unsafe { device.OpenSharedResource(HANDLE(tex_handle as usize as *mut _), &mut texture) }
        .context("OpenSharedResource 失敗（可能與遊戲不在同一張顯示卡）")?;
    let texture = texture.context("沒有共享材質")?;
    println!("[probe] 共享材質開啟成功，開始 {seconds} 秒驗證（每秒讀回一次）");

    let mut last_hash = 0;
    for second in 1..=seconds {
        std::thread::sleep(Duration::from_secs(1));
        if signalled(&stop, 0) {
            println!("[probe] hook 送出停止訊號");
            break;
        }
        let (fg, iconic) = foreground_pid();
        let (luma, hash, small) = read_back(&device, &context, &texture)?;
        let changed = hash != last_hash;
        last_hash = hash;
        println!(
            "[probe] {second:>3}s 亮度 {luma:>6.1} {} 遊戲{}{}",
            if changed {
                "畫面有更新"
            } else {
                "畫面未變  "
            },
            if fg == pid { "在前景" } else { "在背景" },
            if iconic { "（最小化）" } else { "" }
        );
        if second % 5 == 0 {
            save_bmp(&out_dir.join(format!("shot_{second:03}.bmp")), &small)?;
        }
        let _ = std::io::stdout().flush();
    }
    // SAFETY: 有效事件；通知 hook 停止擷取（DLL 仍留在遊戲裡，下次可直接沿用）。
    unsafe {
        let _ = SetEvent(stop.0);
    }
    println!("[probe] 結束；截圖在 {}", out_dir.display());
    Ok(())
}
