//! DXGI Desktop Duplication 擷取（DDA）。擷取 Apex 視窗所在的**整個螢幕**：
//! 推測 WGC 視窗擷取會讓全螢幕遊戲退出獨立翻轉（independent flip）改由 DWM 合成，多一格延遲；
//! DDA 讀的是整個輸出的桌面影像，不針對遊戲視窗要求合成（實際延遲差異需實機 A/B 驗證）。
//! 與 WGC 一樣是 Windows 官方 API，不注入、不碰遊戲程序。
//!
//! - 影格：DDA 桌面 texture 直接交給消費者（消費者只排入 GPU 複製，見 `CapturedFrame`），
//!   呼叫結束後才 `ReleaseFrame`，省掉一次全畫面複製。
//! - 游標：DDA 的桌面影像本來就不含游標（游標另以 pointer shape 提供），這裡不合成，與 WGC 一致。
//! - 前景視窗不屬於目標 PID 或已最小化時，持續送出 GPU 黑幀，避免錄到其他程式。
//! - `DXGI_ERROR_ACCESS_LOST`（換解析度、切全螢幕、UAC 安全桌面）：丟掉 duplication 後重建。
//! - 限制：螢幕旋轉（90°／180°／270°）時桌面影像是面板原生方向，目前原樣錄下並在 stderr 警告；
//!   HDR 螢幕由 `DuplicateOutput1` 要求 BGRA，系統轉成 SDR（顏色可能偏淡）。

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use windows::core::{Interface, HRESULT};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION, DXGI_MODE_ROTATION_IDENTITY,
    DXGI_MODE_ROTATION_UNSPECIFIED, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIDevice, IDXGIFactory1, IDXGIOutput, IDXGIOutput1,
    IDXGIOutput5, IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST,
    DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, HMONITOR, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::Performance::QueryPerformanceFrequency;
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
};

use super::{
    find_window, window_matches, CaptureNotice, CaptureOptions, CapturedFrame, FrameConsumer,
};
use crate::clock;
use crate::gpu::Gpu;

/// 輪詢間隔上下限。`AcquireNextFrame` 等待期間會占住共用裝置的 multithread 鎖，
/// 擋住編碼與小圖（實測音訊佇列因此滿出），所以一律以 0 逾時輪詢、在鎖外休眠。
const POLL_MIN: Duration = Duration::from_millis(1);
const POLL_MAX: Duration = Duration::from_millis(8);
/// duplication 失效後的重建間隔（UAC 桌面、切模式期間會持續失敗）。
const RETRY_INTERVAL: Duration = Duration::from_millis(250);
/// 重建持續失敗超過此時間才通知 `WindowLost`，避免切全螢幕的短暫中斷也發通知。
const LOST_AFTER: Duration = Duration::from_secs(3);
/// 檢查遊戲視窗是否仍在、是否移到別的螢幕的間隔。
const WINDOW_CHECK: Duration = Duration::from_secs(1);
/// `LastPresentTime` 比現在舊超過此值（100 ms）就視為過期，改用現在。
const MAX_PRESENT_AGE: i64 = clock::TICKS_PER_SEC / 10;

/// 依 PID 找遊戲視窗所在螢幕，在擁有該螢幕的轉接器上建立共用裝置。
/// DDA 只能由輸出所屬轉接器上的裝置複製（雙顯卡筆電常見內顯接螢幕）。
pub fn gpu_for_pid(pid: u32) -> Result<Gpu> {
    let monitor = monitor_of(find_window(pid)?);
    // SAFETY: 建立 DXGI factory 不需要額外前置條件；回傳的 COM 物件由 windows crate 管理。
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.context("capture_failed: 建立 DXGI factory 失敗")?;
    let mut adapters = Vec::new();
    for index in 0.. {
        // SAFETY: 依序列舉，序號超出範圍時回傳 DXGI_ERROR_NOT_FOUND。
        match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => {
                let adapter: IDXGIAdapter = adapter.cast()?;
                let monitors: Vec<isize> = output_monitors(&adapter)?
                    .into_iter()
                    .map(|(_, monitor)| monitor)
                    .collect();
                adapters.push((adapter, monitors));
            }
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(error).context("capture_failed: 列舉顯示卡失敗"),
        }
    }
    let monitors: Vec<Vec<isize>> = adapters.iter().map(|(_, m)| m.clone()).collect();
    let (adapter, _) = locate(&monitors, monitor.0 as isize)
        .context("capture_failed: 找不到遊戲所在螢幕對應的 DXGI 輸出")?;
    Gpu::create_on(&adapters[adapter].0)
        .context("capture_failed: 無法在遊戲螢幕所屬的顯示卡上建立 D3D11 裝置")
}

/// 在「每張轉接器的輸出 HMONITOR 清單」中找目標螢幕，回傳（轉接器序號, 輸出序號）。
/// 同一個螢幕只會出現在一張轉接器上；萬一重複，取列舉順序第一個。
fn locate(adapters: &[Vec<isize>], monitor: isize) -> Option<(usize, usize)> {
    adapters.iter().enumerate().find_map(|(adapter, outputs)| {
        outputs
            .iter()
            .position(|&m| m == monitor)
            .map(|output| (adapter, output))
    })
}

/// 列舉轉接器的所有輸出與其 HMONITOR（未接上桌面的輸出 HMONITOR 為 0）。
fn output_monitors(adapter: &IDXGIAdapter) -> Result<Vec<(IDXGIOutput, isize)>> {
    let mut outputs = Vec::new();
    for index in 0.. {
        // SAFETY: 依序列舉，序號超出範圍時回傳 DXGI_ERROR_NOT_FOUND。
        match unsafe { adapter.EnumOutputs(index) } {
            Ok(output) => {
                // SAFETY: output 是剛列舉到的有效 COM 物件。
                let desc =
                    unsafe { output.GetDesc() }.context("capture_failed: 讀取輸出資訊失敗")?;
                outputs.push((output, desc.Monitor.0 as isize));
            }
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(error).context("capture_failed: 列舉螢幕輸出失敗"),
        }
    }
    Ok(outputs)
}

fn monitor_of(hwnd: HWND) -> HMONITOR {
    // SAFETY: HWND 可能已失效；MONITOR_DEFAULTTONEAREST 一律回傳有效螢幕。
    unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) }
}

fn qpc_frequency() -> i64 {
    let mut freq = 0i64;
    // SAFETY: 只寫入提供的 i64；Windows XP 以後永不失敗。
    unsafe {
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    freq.max(1)
}

/// 影格時間戳（100 ns tick，相對 origin）。`accumulated == 0` 表示只有游標更新、
/// 桌面影像沒變，回傳 `None`（不送重複畫面）。`last_present` 是 QPC count；為 0、在未來、
/// 或比現在舊超過 `MAX_PRESENT_AGE`（例：剛建立 duplication 時靜止桌面的第一格）時改用現在，
/// 避免第一格時間戳落在數秒前而讓影音起點錯開。
fn frame_pts(last_present: i64, accumulated: u32, now: i64, freq: i64, origin: i64) -> Option<i64> {
    if accumulated == 0 {
        return None;
    }
    let present = clock::qpc_to_ticks(last_present, freq);
    let ticks = if last_present != 0 && present <= now && now - present <= MAX_PRESENT_AGE {
        present
    } else {
        now
    };
    Some(ticks - origin)
}

/// DDA 選格與時間戳對齊。
///
/// WGC 有 `MinUpdateInterval`，送來的影格間隔至少一格；DDA 則緊貼螢幕更新（例：240 Hz 下
/// 時間戳以 4.17 ms 為單位跳動）。若沿用 `FrameGate`（向下取整的時間桶），相鄰兩格可能不到
/// 一格間隔，被編碼器「四捨五入到 1/fps 格、同格丟棄」的規則判成丟格（實測 4K 20 秒丟 167 格）。
/// 這裡改用與編碼器相同的四捨五入選格，並把 pts 對齊到格點（誤差 ≤ 半格），
/// 編碼器不論以哪一格為起點，換算出的格號都是整數、不會再撞格。
struct SlotGate {
    fps: i128,
    origin: Option<i64>,
    last: Option<i64>,
}

impl SlotGate {
    fn new(fps: u32) -> Self {
        Self {
            fps: fps.max(1) as i128,
            origin: None,
            last: None,
        }
    }

    /// 查詢下一格但不消耗，讓靜止桌面可先檢查前景，再決定是否補黑幀。
    fn candidate(&mut self, pts: i64) -> Option<(i64, i64)> {
        if pts < 0 {
            return None;
        }
        let origin = *self.origin.get_or_insert(pts);
        let offset = pts.checked_sub(origin).filter(|offset| *offset >= 0)?;
        let ticks = clock::TICKS_PER_SEC as i128;
        let slot = ((offset as i128 * self.fps + ticks / 2) / ticks) as i64;
        if self.last.is_some_and(|last| slot <= last) {
            return None;
        }
        Some((slot, origin + (slot as i128 * ticks / self.fps) as i64))
    }

    /// 回傳對齊後的 pts；同一格已送過、或時間倒退時回傳 `None`。
    fn accept(&mut self, pts: i64) -> Option<i64> {
        let (slot, pts) = self.candidate(pts)?;
        self.last = Some(slot);
        Some(pts)
    }
}

/// 僅查詢視窗管理員，不開啟目標程序；查詢失敗或沒有前景視窗時一律視為隱藏。
fn foreground_state() -> (Option<u32>, bool) {
    // SAFETY: HWND 僅用於查詢；視窗消失時 PID 會維持 0，不會取得程序控制代碼。
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        ((pid != 0).then_some(pid), IsIconic(hwnd).as_bool())
    }
}

fn game_visible(pid: u32, foreground_pid: Option<u32>, iconic: bool) -> bool {
    foreground_pid == Some(pid) && !iconic
}

/// 每個輸出時段最多查詢一次；靜止桌面也要輪詢，才能在沒有新 DDA 影格時切成黑畫面。
struct Visibility {
    checked: Option<i64>,
    visible: bool,
}

impl Visibility {
    fn new() -> Self {
        Self {
            checked: None,
            visible: true,
        }
    }

    fn update(
        &mut self,
        pid: u32,
        pts: i64,
        query: impl FnOnce() -> (Option<u32>, bool),
    ) -> Option<CaptureNotice> {
        if self.checked.is_some_and(|last| pts <= last) {
            return None;
        }
        self.checked = Some(pts);
        let (foreground_pid, iconic) = query();
        let visible = game_visible(pid, foreground_pid, iconic);
        if visible == self.visible {
            return None;
        }
        self.visible = visible;
        Some(if visible {
            CaptureNotice::GameVisible { pts }
        } else {
            CaptureNotice::GameHidden { pts }
        })
    }
}

/// 只在初始化或尺寸改變時配置，清成不透明黑色後重複使用；不讀回 CPU。
struct BlackFrame {
    texture: ID3D11Texture2D,
    size: (u32, u32),
}

impl BlackFrame {
    fn new(gpu: &Gpu, size: (u32, u32)) -> Result<Self> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
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
        let mut texture = None;
        let mut view = None;
        // SAFETY: 同裝置、單層單取樣 BGRA texture；清除只寫入本物件擁有的資源。
        let texture = unsafe {
            gpu.device
                .CreateTexture2D(&desc, None, Some(&mut texture))?;
            let texture = texture.context("capture_failed: 缺少 DDA 黑幀 texture")?;
            gpu.device
                .CreateRenderTargetView(&texture, None, Some(&mut view))?;
            let view = view.context("capture_failed: 缺少 DDA 黑幀 render target")?;
            gpu.context
                .ClearRenderTargetView(&view, &[0.0, 0.0, 0.0, 1.0]);
            texture
        };
        Ok(Self { texture, size })
    }

    fn deliver(&self, consumer: &mut dyn FrameConsumer, pts: i64) {
        consumer.on_frame(&CapturedFrame {
            texture: &self.texture,
            width: self.size.0,
            height: self.size.1,
            pts,
        });
    }
}

/// 新桌面影格與逾時補黑幀共用時段及前景快取，避免同格重複查詢或重複輸出。
struct Output {
    pid: u32,
    gate: SlotGate,
    visibility: Visibility,
    black: BlackFrame,
    notices: Sender<CaptureNotice>,
}

impl Output {
    fn visible(&mut self, pts: i64) -> bool {
        // AcquireNextFrame 已返回，這裡沒有持有 GPU 或消費者的鎖。
        if let Some(notice) = self.visibility.update(self.pid, pts, foreground_state) {
            let _ = self.notices.send(notice);
        }
        self.visibility.visible
    }

    fn idle(&mut self, consumer: &mut dyn FrameConsumer, now: i64) {
        if let Some((_, pts)) = self.gate.candidate(now) {
            if !self.visible(pts) {
                if let Some(pts) = self.gate.accept(now) {
                    self.black.deliver(consumer, pts);
                }
            }
        }
    }
}

/// 沒有新影格時的休眠時間：目標幀距的一半，夾在 1–8 ms。時間戳取自 `LastPresentTime`，
/// 輪詢延遲不影響 pts。
fn poll_interval(max_fps: u32) -> Duration {
    (Duration::from_secs(1) / (2 * max_fps.max(1))).clamp(POLL_MIN, POLL_MAX)
}

/// 旋轉螢幕時 DDA 給的是面板原生方向的影像（尚未處理）。
fn rotation_unhandled(rotation: DXGI_MODE_ROTATION) -> bool {
    rotation != DXGI_MODE_ROTATION_IDENTITY && rotation != DXGI_MODE_ROTATION_UNSPECIFIED
}

#[derive(Debug, PartialEq, Eq)]
enum AcquireError {
    /// duplication 已失效，需要重建。
    Lost,
    /// 其他錯誤；同樣重建，但記錄原因。
    Failed(HRESULT),
}

fn classify(code: HRESULT) -> Option<AcquireError> {
    if code == DXGI_ERROR_WAIT_TIMEOUT {
        None
    } else if code == DXGI_ERROR_ACCESS_LOST {
        Some(AcquireError::Lost)
    } else {
        Some(AcquireError::Failed(code))
    }
}

struct Duplication {
    dup: IDXGIOutputDuplication,
    size: (u32, u32),
}

/// 已取得的 DDA 影格；離開作用域時 `ReleaseFrame`。
struct Acquired<'a> {
    dup: &'a IDXGIOutputDuplication,
    info: DXGI_OUTDUPL_FRAME_INFO,
    resource: Option<IDXGIResource>,
}

impl Drop for Acquired<'_> {
    fn drop(&mut self) {
        // SAFETY: 只在 AcquireNextFrame 成功後建立，與該次取得一對一配對。
        let _ = unsafe { self.dup.ReleaseFrame() };
    }
}

impl Duplication {
    /// 在 `gpu` 的轉接器上找 `monitor` 的輸出並建立 duplication。
    fn open(gpu: &Gpu, monitor: HMONITOR) -> Result<Self> {
        let dxgi: IDXGIDevice = gpu.device.cast()?;
        // SAFETY: 共用裝置的 DXGI 介面；只讀取所屬轉接器。
        let adapter = unsafe { dxgi.GetAdapter() }.context("capture_failed: 取得顯示卡失敗")?;
        let Some((output, _)) = output_monitors(&adapter)?
            .into_iter()
            .find(|(_, m)| *m == monitor.0 as isize)
        else {
            bail!(
                "capture_failed: 遊戲所在螢幕不是由錄影使用的顯示卡輸出，DDA 無法擷取（請改用視窗擷取）"
            );
        };
        let dup = duplicate(&output, gpu)?;
        // SAFETY: dup 是剛建立的有效 duplication。
        let desc = unsafe { dup.GetDesc() };
        if desc.DesktopImageInSystemMemory.as_bool() {
            bail!(
                "capture_failed: 此顯示驅動把桌面影像放在系統記憶體，DDA 不支援（請改用視窗擷取）"
            );
        }
        if rotation_unhandled(desc.Rotation) {
            eprintln!(
                "DDA：螢幕已旋轉（{}），錄影畫面將維持面板原生方向",
                desc.Rotation.0
            );
        }
        Ok(Self {
            dup,
            size: (desc.ModeDesc.Width, desc.ModeDesc.Height),
        })
    }

    /// 等下一格；逾時回傳 `Ok(None)`。
    fn next(&self, timeout_ms: u32) -> Result<Option<Acquired<'_>>, AcquireError> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;
        // SAFETY: 輸出指標指向本函式的區域變數；成功時由 Acquired guard 配對 ReleaseFrame。
        match unsafe {
            self.dup
                .AcquireNextFrame(timeout_ms, &mut info, &mut resource)
        } {
            Ok(()) => Ok(Some(Acquired {
                dup: &self.dup,
                info,
                resource,
            })),
            Err(error) => match classify(error.code()) {
                None => Ok(None),
                Some(error) => Err(error),
            },
        }
    }
}

fn duplicate(output: &IDXGIOutput, gpu: &Gpu) -> Result<IDXGIOutputDuplication> {
    // 優先用 DuplicateOutput1 指定 BGRA（HDR／FP16 桌面由系統轉換）；舊系統退回 DuplicateOutput。
    if let Ok(output5) = output.cast::<IDXGIOutput5>() {
        // SAFETY: 裝置屬於此輸出的轉接器；格式陣列在呼叫期間有效。
        match unsafe { output5.DuplicateOutput1(&gpu.device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]) } {
            Ok(dup) => return Ok(dup),
            Err(error) => eprintln!("DDA：DuplicateOutput1 失敗（{error}），改用 DuplicateOutput"),
        }
    }
    let output1: IDXGIOutput1 = output
        .cast()
        .context("capture_failed: 系統不支援 Desktop Duplication")?;
    // SAFETY: 裝置屬於此輸出的轉接器。
    unsafe { output1.DuplicateOutput(&gpu.device) }
        .context("capture_failed: 建立 Desktop Duplication 失敗")
}

/// 擷取管理狀態：目前追蹤的視窗、螢幕與 duplication。
struct Tracker {
    pid: u32,
    hwnd: Option<HWND>,
    monitor: HMONITOR,
    dup: Option<Duplication>,
    /// 最近一次通知的尺寸；`None` 表示下次建立成功時必須通知。
    announced: Option<(u32, u32)>,
    retry_at: Instant,
    /// 這次中斷開始的時間（重建失敗中）。
    failing_since: Option<Instant>,
    lost_reported: bool,
    notices: Sender<CaptureNotice>,
}

impl Tracker {
    fn announce(&mut self, size: (u32, u32)) {
        if self.announced != Some(size) {
            self.announced = Some(size);
            let _ = self.notices.send(CaptureNotice::WindowFound {
                width: size.0,
                height: size.1,
                monitor: true,
            });
        }
    }

    fn lose_window(&mut self) {
        self.hwnd = None;
        self.dup = None;
        self.announced = None;
        self.failing_since = None;
        if !self.lost_reported {
            self.lost_reported = true;
            let _ = self.notices.send(CaptureNotice::WindowLost);
        }
    }

    /// 每秒一次：視窗消失、重新出現或換螢幕。
    fn check_window(&mut self) {
        match self.hwnd {
            Some(hwnd) if !window_matches(hwnd, self.pid) => self.lose_window(),
            Some(hwnd) => {
                let monitor = monitor_of(hwnd);
                if monitor != self.monitor {
                    // 遊戲移到別的螢幕：重建到新螢幕（尺寸可能不同，必定重新通知）。
                    self.monitor = monitor;
                    self.dup = None;
                    self.announced = None;
                    self.retry_at = Instant::now();
                }
            }
            None => {
                if let Ok(hwnd) = find_window(self.pid) {
                    self.hwnd = Some(hwnd);
                    self.monitor = monitor_of(hwnd);
                    self.announced = None;
                    self.retry_at = Instant::now();
                }
            }
        }
    }

    /// duplication 失效時依間隔重建。
    fn reopen(&mut self, gpu: &Gpu) {
        if self.hwnd.is_none() || Instant::now() < self.retry_at {
            return;
        }
        match Duplication::open(gpu, self.monitor) {
            Ok(dup) => {
                let size = dup.size;
                self.dup = Some(dup);
                self.failing_since = None;
                self.lost_reported = false;
                self.announce(size);
            }
            Err(error) => {
                let since = *self.failing_since.get_or_insert_with(|| {
                    eprintln!("DDA 重建失敗，持續重試：{error:#}");
                    Instant::now()
                });
                if since.elapsed() >= LOST_AFTER && !self.lost_reported {
                    self.lost_reported = true;
                    self.announced = None;
                    let _ = self.notices.send(CaptureNotice::WindowLost);
                }
                self.retry_at = Instant::now() + RETRY_INTERVAL;
            }
        }
    }
}

/// 取得的影格交給消費者；回傳 `Err` 表示影格格式不符（只記錄一次）。
fn deliver(
    frame: &Acquired<'_>,
    consumer: &mut dyn FrameConsumer,
    output: &mut Output,
    freq: i64,
    origin: i64,
) -> Result<Option<(u32, u32)>> {
    let Some(pts) = frame_pts(
        frame.info.LastPresentTime,
        frame.info.AccumulatedFrames,
        clock::now_ticks(),
        freq,
        origin,
    ) else {
        return Ok(None);
    };
    let Some(resource) = &frame.resource else {
        return Ok(None);
    };
    let Some(pts) = output.gate.accept(pts) else {
        return Ok(None);
    };
    let texture: ID3D11Texture2D = resource.cast().context("DDA 影格不是 D3D11 texture")?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: texture 在 Acquired guard 存活期間有效；desc 是可寫入的描述結構。
    unsafe { texture.GetDesc(&mut desc) };
    if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || desc.SampleDesc.Count != 1 {
        bail!("DDA 桌面影像格式 {} 不是 BGRA，略過", desc.Format.0);
    }
    if output.visible(pts) {
        consumer.on_frame(&CapturedFrame {
            texture: &texture,
            width: desc.Width,
            height: desc.Height,
            pts,
        });
    } else {
        output.black.deliver(consumer, pts);
    }
    Ok(Some((desc.Width, desc.Height)))
}

pub(super) fn run(
    gpu: Gpu,
    opts: CaptureOptions,
    mut consumer: Box<dyn FrameConsumer>,
    notices: Sender<CaptureNotice>,
    stopped: Receiver<()>,
    ready: &mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    // SAFETY: 只設定本擷取執行緒的 DPI 模式；DuplicateOutput1 需要 per-monitor DPI aware。
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let freq = qpc_frequency();
    let hwnd = find_window(opts.pid)?;
    let monitor = monitor_of(hwnd);
    let dup = Duplication::open(&gpu, monitor).context("capture_failed: 建立 DDA 擷取失敗")?;
    let mut output = Output {
        pid: opts.pid,
        gate: SlotGate::new(opts.max_fps),
        visibility: Visibility::new(),
        black: BlackFrame::new(&gpu, dup.size).context("capture_failed: 建立 DDA 黑幀失敗")?,
        notices: notices.clone(),
    };
    let mut tracker = Tracker {
        pid: opts.pid,
        hwnd: Some(hwnd),
        monitor,
        dup: None,
        announced: None,
        retry_at: Instant::now(),
        failing_since: None,
        lost_reported: false,
        notices,
    };
    tracker.announce(dup.size);
    tracker.dup = Some(dup);
    let _ = ready.send(Ok(()));
    let poll = poll_interval(opts.max_fps);
    let mut format_warned = false;
    let mut next_check = Instant::now() + WINDOW_CHECK;
    loop {
        match stopped.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if Instant::now() >= next_check {
            next_check = Instant::now() + WINDOW_CHECK;
            tracker.check_window();
        }
        if tracker.dup.is_none() {
            tracker.reopen(&gpu);
        }
        if let Some(dup) = &tracker.dup {
            if output.black.size != dup.size {
                output.black = BlackFrame::new(&gpu, dup.size)
                    .context("capture_failed: 調整 DDA 黑幀尺寸失敗")?;
            }
        }
        let Some(dup) = &tracker.dup else {
            output.idle(consumer.as_mut(), clock::now_ticks() - opts.origin_ticks);
            match stopped.recv_timeout(poll) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
            }
        };
        // 先在借用 duplication 的範圍內處理影格（frame drop → ReleaseFrame），再更新狀態。
        let outcome = match dup.next(0) {
            Ok(None) => Ok(None),
            Ok(Some(frame)) => Ok(
                match deliver(
                    &frame,
                    consumer.as_mut(),
                    &mut output,
                    freq,
                    opts.origin_ticks,
                ) {
                    Ok(size) => size,
                    Err(error) => {
                        if !format_warned {
                            format_warned = true;
                            eprintln!("{error:#}");
                        }
                        None
                    }
                },
            ),
            Err(error) => Err(error),
        };
        match outcome {
            Ok(Some(size)) => tracker.announce(size),
            Ok(None) => {
                output.idle(consumer.as_mut(), clock::now_ticks() - opts.origin_ticks);
                thread::sleep(poll);
            }
            Err(AcquireError::Lost) => {
                tracker.dup = None;
                tracker.retry_at = Instant::now();
            }
            Err(AcquireError::Failed(code)) => {
                eprintln!("DDA 取得影格失敗（{code}），重建擷取");
                tracker.dup = None;
                tracker.retry_at = Instant::now() + RETRY_INTERVAL;
            }
        }
    }
    // 先釋放 duplication，再釋放消費者。
    drop(tracker);
    drop(consumer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::TICKS_PER_SEC;
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_MODE_ROTATION_ROTATE180, DXGI_MODE_ROTATION_ROTATE270, DXGI_MODE_ROTATION_ROTATE90,
    };
    use windows::Win32::Graphics::Dxgi::DXGI_ERROR_INVALID_CALL;

    #[test]
    fn visibility_requires_target_foreground_pid_and_non_iconic_window() {
        for (foreground, iconic, expected) in [
            (Some(42), false, true),
            (Some(42), true, false),
            (Some(7), false, false),
            (Some(7), true, false),
            (None, false, false),
            (None, true, false),
        ] {
            assert_eq!(game_visible(42, foreground, iconic), expected);
        }
    }

    #[test]
    fn visibility_queries_once_per_slot_and_reports_only_transitions() {
        let mut visibility = Visibility::new();
        let mut gate = SlotGate::new(60);
        let mut queries = 0;
        for (pts, foreground, iconic, expected) in [
            (0, Some(42), false, None),
            (
                166_667,
                Some(7),
                false,
                Some(CaptureNotice::GameHidden { pts: 166_666 }),
            ),
            (333_334, None, false, None),
            (500_000, Some(42), true, None),
            (
                666_667,
                Some(42),
                false,
                Some(CaptureNotice::GameVisible { pts: 666_666 }),
            ),
        ] {
            let (_, pts) = gate.candidate(pts).unwrap();
            assert_eq!(
                visibility.update(42, pts, || {
                    queries += 1;
                    (foreground, iconic)
                }),
                expected
            );
            assert_eq!(visibility.update(42, pts, || panic!("同格重複查詢")), None);
        }
        assert_eq!(queries, 5);
        let mut initially_hidden = Visibility::new();
        assert_eq!(
            initially_hidden.update(42, 0, || (None, false)),
            Some(CaptureNotice::GameHidden { pts: 0 })
        );
    }

    #[test]
    fn hidden_frames_advance_without_desktop_updates_and_share_output_slots() {
        let mut visibility = Visibility::new();
        let mut gate = SlotGate::new(60);
        assert_eq!(gate.accept(0), Some(0));
        let mut output = Vec::new();
        for now in (0..=TICKS_PER_SEC).step_by(10_000) {
            if let Some((_, pts)) = gate.candidate(now) {
                visibility.update(42, pts, || (None, false));
                if !visibility.visible {
                    if let Some(pts) = gate.accept(now) {
                        output.push(pts);
                    }
                }
            }
        }
        assert_eq!(output.len(), 60);
        assert_eq!(output[0], TICKS_PER_SEC / 60);
        assert_eq!(output.last(), Some(&TICKS_PER_SEC));
        assert_eq!(encoder_drops(&output, 60), 0);
        assert_eq!(gate.accept(TICKS_PER_SEC), None);
    }

    #[test]
    fn gpu_idle_black_frames_reach_small_frames_without_desktop_updates() {
        use crate::capture::small::{SmallFrameExtractor, SmallFrames};
        use crate::types::FramesSpec;

        struct Consumer {
            extractor: SmallFrameExtractor,
            frames: Vec<SmallFrames>,
            captured: Vec<(i64, u32, u32)>,
        }
        impl FrameConsumer for Consumer {
            fn on_frame(&mut self, frame: &CapturedFrame<'_>) {
                self.captured.push((frame.pts, frame.width, frame.height));
                if let Some(small) =
                    self.extractor
                        .on_frame(frame.texture, frame.width, frame.height, frame.pts)
                {
                    self.frames.push(small);
                }
            }
        }
        let gpu = Gpu::create().unwrap();
        for size in [(960, 540), (1920, 1080)] {
            let (notices, received) = mpsc::channel();
            let mut output = Output {
                pid: u32::MAX,
                gate: SlotGate::new(60),
                visibility: Visibility::new(),
                black: BlackFrame::new(&gpu, size).unwrap(),
                notices,
            };
            let mut consumer = Consumer {
                extractor: SmallFrameExtractor::new(
                    &gpu,
                    FramesSpec {
                        banner: [0, 0, 96, 48],
                        spec: [960, 540, 96, 48],
                        base: [1920, 1080],
                    },
                )
                .unwrap(),
                frames: Vec::new(),
                captured: Vec::new(),
            };
            for slot in 0..4 {
                let pts = slot * TICKS_PER_SEC / 4;
                output.idle(&mut consumer, pts);
                output.idle(&mut consumer, pts + 1);
                // SAFETY: 只提交測試裝置的命令，讓非同步小圖讀回在下次取樣前完成。
                unsafe { gpu.context.Flush() };
                thread::sleep(Duration::from_millis(100));
            }
            assert_eq!(consumer.captured.len(), 4);
            assert!(consumer.captured.iter().all(|f| (f.1, f.2) == size));
            assert_eq!(
                received.try_iter().collect::<Vec<_>>(),
                vec![CaptureNotice::GameHidden { pts: 0 }]
            );
            assert_eq!(consumer.frames.len(), 3);
            assert!(consumer.frames[0].thumb.is_some());
            for (slot, small) in consumer.frames.iter().enumerate() {
                assert_eq!(small.pts, slot as i64 * TICKS_PER_SEC / 4);
                assert!(small
                    .banner
                    .iter()
                    .chain(&small.spec)
                    .chain(small.thumb.iter().flatten())
                    .all(|&v| v == 0));
            }
        }
    }

    #[test]
    fn locate_finds_adapter_and_output_owning_the_monitor() {
        let adapters = vec![vec![], vec![0x10, 0x20], vec![0x30]];
        assert_eq!(locate(&adapters, 0x20), Some((1, 1)));
        assert_eq!(locate(&adapters, 0x30), Some((2, 0)));
        assert_eq!(locate(&adapters, 0x40), None);
        assert_eq!(locate(&[], 0x10), None);
        // 重複時取列舉順序第一個（預設轉接器優先）。
        assert_eq!(locate(&[vec![0x10], vec![0x10]], 0x10), Some((0, 0)));
    }

    #[test]
    fn frame_pts_prefers_present_time_and_skips_pointer_only_updates() {
        let freq = 10_000_000;
        assert_eq!(frame_pts(5_000, 1, 9_999, freq, 1_000), Some(4_000));
        // 只有游標移動：沒有新桌面影像。
        assert_eq!(frame_pts(5_000, 0, 9_999, freq, 1_000), None);
        // LastPresentTime 為 0 時用現在。
        assert_eq!(frame_pts(0, 2, 9_999, freq, 1_000), Some(8_999));
        // 非 10 MHz 的 QPC 頻率要換算成 100 ns tick。
        assert_eq!(
            frame_pts(3_000_000, 1, TICKS_PER_SEC + 10, 3_000_000, 0),
            Some(TICKS_PER_SEC)
        );
        // 過期（靜止桌面的第一格）或在未來的 present 時間改用現在。
        let now = 100 * TICKS_PER_SEC;
        assert_eq!(
            frame_pts(now - MAX_PRESENT_AGE, 1, now, freq, 0),
            Some(now - MAX_PRESENT_AGE)
        );
        assert_eq!(
            frame_pts(now - MAX_PRESENT_AGE - 1, 1, now, freq, 0),
            Some(now)
        );
        assert_eq!(frame_pts(now + 1, 1, now, freq, 0), Some(now));
    }

    /// 模擬編碼器的選格規則（`encode::SegmentWriter::push_video`）：以第一個收到的 pts 為起點，
    /// 四捨五入到 1/fps 格，格號不前進就丟格。
    fn encoder_drops(pts: &[i64], fps: i64) -> usize {
        let origin = pts[0];
        let mut last = None;
        let mut drops = 0;
        for &p in pts {
            let slot = ((p - origin) as i128 * fps as i128 + 5_000_000) / 10_000_000;
            if last.is_some_and(|l| slot <= l) {
                drops += 1;
            } else {
                last = Some(slot);
            }
        }
        drops
    }

    #[test]
    fn slot_gate_rounds_like_the_encoder_and_snaps_to_slot_times() {
        let mut gate = SlotGate::new(60);
        assert_eq!(gate.accept(-1), None);
        assert_eq!(gate.accept(1_000), Some(1_000));
        // 不到半格：同一格，丟。
        assert_eq!(gate.accept(1_000 + 83_333), None);
        // 超過半格：下一格，對齊到格點（1/60 s = 166_666 tick）。
        assert_eq!(gate.accept(1_000 + 83_334), Some(1_000 + 166_666));
        assert_eq!(
            gate.accept(1_000 + 2 * 166_667 + 40_000),
            Some(1_000 + 333_333)
        );
        // 時間倒退：丟。
        assert_eq!(gate.accept(500), None);
        assert_eq!(
            gate.accept(1_000 + 10 * TICKS_PER_SEC),
            Some(1_000 + 10 * TICKS_PER_SEC)
        );
    }

    #[test]
    fn slot_gate_output_never_collides_in_the_encoder_whatever_its_origin() {
        // 240 Hz 螢幕上約 64 Hz 更新的視窗：present 時間落在 4.17 ms 格線上（實測的丟格情境）。
        let vsync = TICKS_PER_SEC / 240;
        let presents: Vec<i64> = (0..2_000)
            .map(|i| {
                let t = 7 * TICKS_PER_SEC + i * 156_250;
                (t + vsync - 1) / vsync * vsync
            })
            .collect();
        for fps in [30, 60, 120, 144] {
            let mut gate = SlotGate::new(fps);
            let out: Vec<i64> = presents.iter().filter_map(|&p| gate.accept(p)).collect();
            assert!(out.windows(2).all(|pair| pair[0] < pair[1]));
            for skip in [0, 1, 7, 33] {
                assert_eq!(
                    encoder_drops(&out[skip..], fps as i64),
                    0,
                    "fps {fps} 起點 {skip}"
                );
            }
        }
        // 對照：直接把 present 時間送進編碼器規則會撞格。
        assert!(encoder_drops(&presents, 60) > 0);
    }

    #[test]
    fn poll_interval_is_half_frame_clamped() {
        assert_eq!(poll_interval(60), Duration::from_millis(8));
        assert_eq!(poll_interval(144), Duration::from_nanos(3_472_222));
        assert_eq!(poll_interval(30), POLL_MAX);
        assert_eq!(poll_interval(10_000), POLL_MIN);
        assert_eq!(poll_interval(0), POLL_MAX);
    }

    #[test]
    fn classifies_acquire_results() {
        assert_eq!(classify(DXGI_ERROR_WAIT_TIMEOUT), None);
        assert_eq!(classify(DXGI_ERROR_ACCESS_LOST), Some(AcquireError::Lost));
        assert_eq!(
            classify(DXGI_ERROR_INVALID_CALL),
            Some(AcquireError::Failed(DXGI_ERROR_INVALID_CALL))
        );
    }

    #[test]
    fn identity_is_the_only_handled_rotation() {
        assert!(!rotation_unhandled(DXGI_MODE_ROTATION_IDENTITY));
        assert!(!rotation_unhandled(DXGI_MODE_ROTATION_UNSPECIFIED));
        assert!(rotation_unhandled(DXGI_MODE_ROTATION_ROTATE90));
        assert!(rotation_unhandled(DXGI_MODE_ROTATION_ROTATE180));
        assert!(rotation_unhandled(DXGI_MODE_ROTATION_ROTATE270));
    }
}
