//! WASAPI 音訊（任務 B3）：系統聲音 loopback＋麥克風，各自轉成 48 kHz 立體聲 f32，
//! 依 QPC 對齊後混成一軌（規格 §2.4、R7）。
//!
//! 介面由骨架固定，實作者不得改動簽章。

pub mod mix;
mod process;

use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, HANDLE, RPC_E_CHANGED_MODE, WAIT_FAILED};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, EDataFlow, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::clock::{now_ticks, TICKS_PER_SEC};
use crate::protocol::{AudioDevice, AudioDevices};
use crate::types::{AudioConfig, RenderSource, AUDIO_RATE};
use mix::{
    frames_from_ticks, ticks_from_frames, Format, Resampler, Sample, Timeline, BLOCK_FRAMES,
};

const PACKET_CAPACITY: usize = 32;

/// 在音訊執行緒上被呼叫；不得阻塞。`interleaved` 為 48 kHz 立體聲 f32，`pts` 為第一個樣本的 tick。
pub trait AudioSink: Send {
    fn on_audio(&mut self, interleaved: &[f32], pts: i64);
}

pub fn list_devices() -> Result<AudioDevices> {
    let _apartment = Apartment::enter()?;
    let enumerator = enumerator()?;
    Ok(AudioDevices {
        render: devices(&enumerator, eRender)?,
        capture: devices(&enumerator, eCapture)?,
    })
}

pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
    warning: Option<String>,
}

impl AudioCapture {
    /// `origin_ticks`：session 起點的 QPC tick；送出的 pts = 樣本 QPC − origin。
    #[allow(dead_code)] // 保留既有裝置擷取介面供整合測試使用。
    pub fn start(cfg: &AudioConfig, origin_ticks: i64, sink: Box<dyn AudioSink>) -> Result<Self> {
        Self::start_for_pid(cfg, 0, origin_ticks, sink)
    }

    pub fn start_for_pid(
        cfg: &AudioConfig,
        pid: u32,
        origin_ticks: i64,
        sink: Box<dyn AudioSink>,
    ) -> Result<Self> {
        cfg.validate().context("audio_failed: 音訊參數無效")?;
        let mut capture = Self {
            stop: Arc::new(AtomicBool::new(false)),
            workers: Vec::new(),
            warning: None,
        };
        let system = if cfg.render_enabled {
            capture.optional_endpoint(
                cfg.render.clone(),
                false,
                (cfg.render_source == RenderSource::Game).then_some(pid),
            )?
        } else {
            None
        };
        let mut mic = if cfg.mic_enabled {
            capture.optional_endpoint(cfg.capture.clone(), true, None)?
        } else {
            None
        };
        if let Some(mic) = &mut mic {
            mic.format.mono = cfg.mic_mono;
        }
        let config = cfg.clone();
        let stop = capture.stop.clone();
        // 混音另用工作執行緒；WASAPI 執行緒僅複製封包與 try_send，不等待消費者。
        let worker = thread::Builder::new()
            .name("apexrec-audio-mix".into())
            .spawn(move || mix_loop(system, mic, origin_ticks, &config, &stop, sink))
            .context("audio_failed: 建立混音執行緒失敗")?;
        capture.workers.push(worker);
        Ok(capture)
    }

    pub fn take_warning(&mut self) -> Option<String> {
        self.warning.take()
    }

    pub fn stop(mut self) {
        self.shutdown();
    }

    fn optional_endpoint(
        &mut self,
        id: String,
        mic: bool,
        pid: Option<u32>,
    ) -> Result<Option<Source>> {
        match self.spawn_endpoint(id, mic, pid) {
            Ok(source) => Ok(Some(source)),
            Err(error) if format!("{error:#}").contains("audio_device_missing:") => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn spawn_endpoint(&mut self, id: String, mic: bool, pid: Option<u32>) -> Result<Source> {
        let (packets_tx, packets_rx) = mpsc::sync_channel(PACKET_CAPACITY);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let stop = Arc::clone(&self.stop);
        let worker = thread::Builder::new()
            .name(
                if mic {
                    "apexrec-mic"
                } else {
                    "apexrec-loopback"
                }
                .into(),
            )
            .spawn(move || {
                let mut warning = None;
                let opened = if let Some(pid) = pid {
                    EndpointStream::open_process(pid).or_else(|error| {
                        warning = Some(format!("無法只錄遊戲聲音，已改錄系統聲音：{error:#}"));
                        EndpointStream::open(&id, false)
                    })
                } else {
                    EndpointStream::open(&id, mic)
                };
                let stream = match opened {
                    Ok(stream) => stream,
                    Err(error) => {
                        let _ = ready_tx.send((Err(format!("{error:#}")), warning));
                        return;
                    }
                };
                if ready_tx.send((Ok(stream.format.clone()), warning)).is_err() {
                    return;
                }
                let dropped = AtomicU64::new(0);
                if let Err(error) = stream.run(&packets_tx, &stop, &dropped) {
                    eprintln!("audio_failed: 音訊擷取中斷：{error:#}");
                    stop.store(true, Ordering::Release);
                }
                let dropped = dropped.load(Ordering::Relaxed);
                if dropped != 0 {
                    eprintln!("音訊擷取佇列已丟棄 {dropped} 個封包");
                }
            })
            .context("audio_failed: 建立音訊擷取執行緒失敗")?;
        self.workers.push(worker);
        let (format, warning) = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .context("audio_failed: 等待音訊裝置啟動失敗")?;
        if warning.is_some() {
            self.warning = warning;
        }
        let format = format.map_err(|message| anyhow::anyhow!("audio_failed: {message}"))?;
        Ok(Source::new(format, packets_rx))
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        // 先停兩個來源並關閉傳送端；混音執行緒會排空佇列並補齊尾端後退出。
        for worker in self.workers.drain(..) {
            if worker.join().is_err() {
                eprintln!("audio_failed: 音訊執行緒異常結束");
            }
        }
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Apartment {
    initialized: bool,
    _thread: PhantomData<*mut ()>,
}

impl Apartment {
    fn enter() -> Result<Self> {
        // SAFETY: 在目前執行緒初始化 COM；成功的呼叫由同執行緒的 Drop 配對。
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result != RPC_E_CHANGED_MODE {
            result.ok().context("初始化音訊 COM 失敗")?;
        }
        Ok(Self {
            initialized: result.is_ok(),
            _thread: PhantomData,
        })
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: 僅平衡目前執行緒先前成功的 CoInitializeEx。
            unsafe { CoUninitialize() };
        }
    }
}

struct TaskMem<T>(*mut T);

impl<T> Drop for TaskMem<T> {
    fn drop(&mut self) {
        // SAFETY: 此指標只包裝 WASAPI／COM 回傳的 task allocator 配置，且僅釋放一次。
        unsafe { CoTaskMemFree(Some(self.0.cast())) };
    }
}

fn task_string(value: PWSTR) -> Result<String> {
    let memory = TaskMem(value.0);
    // SAFETY: GetId 與 PropVariantToStringAlloc 回傳以 NUL 結尾的有效 UTF-16 配置。
    unsafe { PWSTR(memory.0).to_string() }.context("音訊裝置文字不是有效的 UTF-16")
}

fn enumerator() -> Result<IMMDeviceEnumerator> {
    // SAFETY: 呼叫端已初始化 COM；沒有外部聚合物件，介面由 windows crate 管理。
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
        .context("建立音訊裝置列舉器失敗")
}

fn device_id(device: &IMMDevice) -> Result<String> {
    // SAFETY: device 是有效的 COM 介面，回傳的配置交由 task_string 釋放。
    task_string(unsafe { device.GetId() }.context("讀取音訊裝置 ID 失敗")?)
}

fn devices(enumerator: &IMMDeviceEnumerator, flow: EDataFlow) -> Result<Vec<AudioDevice>> {
    // SAFETY: 列舉器有效，只取得目前啟用中的端點與預設端點。
    let (collection, default) = unsafe {
        (
            enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)?,
            enumerator.GetDefaultAudioEndpoint(flow, eConsole).ok(),
        )
    };
    let default = default.as_ref().map(device_id).transpose()?;
    // SAFETY: collection 是有效的 COM 集合。
    let count = unsafe { collection.GetCount() }?;
    (0..count)
        .map(|index| {
            // SAFETY: index 小於集合長度，屬性以唯讀方式開啟。
            let (device, mut name) = unsafe {
                let device = collection.Item(index)?;
                let properties = device.OpenPropertyStore(STGM_READ)?;
                let name = properties.GetValue(&PKEY_Device_FriendlyName)?;
                (device, name)
            };
            // SAFETY: name 由 GetValue 初始化，轉字串後無論成功或失敗都會清除。
            let text = unsafe { PropVariantToStringAlloc(&name) }
                .map_err(anyhow::Error::from)
                .and_then(task_string);
            // SAFETY: 此 PROPVARIANT 尚未清除，且之後不再讀取。
            unsafe { PropVariantClear(&mut name) }.context("釋放音訊裝置屬性失敗")?;
            let name = text.context("讀取音訊裝置名稱失敗")?;
            let id = device_id(&device)?;
            Ok(AudioDevice {
                default: default.as_ref() == Some(&id),
                id,
                name,
            })
        })
        .collect()
}

struct Event(HANDLE);

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: 此 handle 來自成功的 CreateEventW，且僅由此處關閉一次。
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct EndpointStream {
    capture: IAudioCaptureClient,
    client: IAudioClient,
    event: Event,
    format: Format,
    buffer_frames: u32,
    _apartment: Apartment,
}

impl EndpointStream {
    fn open(id: &str, mic: bool) -> Result<Self> {
        if id.contains('\0') {
            bail!("音訊裝置 ID 含有 NUL 字元");
        }
        let apartment = Apartment::enter()?;
        let enumerator = enumerator()?;
        let wide: Vec<_> = id.encode_utf16().chain(Some(0)).collect();
        // SAFETY: COM 已初始化，wide 存活至呼叫返回；只使用系統音訊端點。
        let device = unsafe {
            if id == "default" {
                enumerator.GetDefaultAudioEndpoint(if mic { eCapture } else { eRender }, eConsole)
            } else {
                enumerator.GetDevice(PCWSTR(wide.as_ptr()))
            }
        }
        .map_err(|error| {
            if id == "default" && error.code().0 == 0x80070490u32 as i32 {
                anyhow::anyhow!("audio_device_missing: 沒有預設音訊裝置")
            } else {
                anyhow::anyhow!("找不到指定的音訊裝置：{error}")
            }
        })?;
        // SAFETY: 在目前執行緒啟用有效裝置的音訊介面。
        let client: IAudioClient =
            unsafe { device.Activate(CLSCTX_ALL, None) }.context("啟用音訊裝置失敗")?;
        // SAFETY: GetMixFormat 配置由 TaskMem 持有，直到 Initialize 返回後才釋放。
        let raw = TaskMem(unsafe { client.GetMixFormat() }.context("取得裝置混音格式失敗")?);
        let format = read_format(&raw)?;
        Self::initialize(client, raw.0, format, mic, apartment)
    }

    fn open_process(pid: u32) -> Result<Self> {
        let apartment = Apartment::enter()?;
        let client = process::activate(pid)?;
        let raw = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
            nChannels: 2,
            nSamplesPerSec: AUDIO_RATE,
            nAvgBytesPerSec: AUDIO_RATE * 8,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        let format = Format::new(AUDIO_RATE, 2, 8, Sample::Float(32), 3)?;
        Self::initialize(client, &raw, format, false, apartment)
    }

    fn initialize(
        client: IAudioClient,
        raw: *const WAVEFORMATEX,
        format: Format,
        mic: bool,
        apartment: Apartment,
    ) -> Result<Self> {
        // SAFETY: 不指定名稱與安全描述元，建立本程序擁有的 auto-reset 事件。
        let event = Event(unsafe { CreateEventW(None, false, false, None) }?);
        let flags =
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK | if mic { 0 } else { AUDCLNT_STREAMFLAGS_LOOPBACK };
        // SAFETY: 格式指標於 Initialize 返回前保持有效；shared event mode 的週期為 0。
        let (capture, buffer_frames) = unsafe {
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, raw, None)?;
            client.SetEventHandle(event.0)?;
            (client.GetService()?, client.GetBufferSize()?)
        };
        let stream = Self {
            capture,
            client,
            event,
            format,
            buffer_frames,
            _apartment: apartment,
        };
        // SAFETY: client 已成功初始化且事件已設定。
        unsafe { stream.client.Start() }.context("啟動音訊串流失敗")?;
        Ok(stream)
    }

    fn run(
        &self,
        packets: &SyncSender<Packet>,
        stop: &AtomicBool,
        dropped: &AtomicU64,
    ) -> Result<()> {
        while !stop.load(Ordering::Acquire) {
            // SAFETY: event 在整個串流生命週期中保持有效；10 ms 逾時涵蓋無聲 loopback。
            if unsafe { WaitForSingleObject(self.event.0, 10) } == WAIT_FAILED {
                return Err(windows::core::Error::from_thread().into());
            }
            loop {
                // SAFETY: capture 已啟動，只在此執行緒存取。
                if unsafe { self.capture.GetNextPacketSize() }? == 0 {
                    break;
                }
                let packet = self.copy_packet()?;
                if !enqueue(packets, packet, dropped) {
                    return Ok(());
                }
                if stop.load(Ordering::Acquire) {
                    break;
                }
            }
        }
        Ok(())
    }

    fn copy_packet(&self) -> Result<Packet> {
        let (mut data, mut frames, mut flags, mut qpc) = (std::ptr::null_mut(), 0, 0, 0);
        // SAFETY: 所有輸出指標有效，GetBuffer／ReleaseBuffer 僅在此執行緒成對執行。
        unsafe {
            self.capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))
        }?;
        let result = (|| {
            if frames > self.buffer_frames {
                bail!("WASAPI 封包超過裝置緩衝大小");
            }
            let bytes = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || frames == 0 {
                Vec::new()
            } else {
                if data.is_null() {
                    bail!("WASAPI 回傳空的音訊資料指標");
                }
                let length = frames as usize * self.format.block_align;
                // SAFETY: GetBuffer 保證提供 frames 個完整 frame，ReleaseBuffer 前指標有效。
                unsafe { std::slice::from_raw_parts(data, length) }.to_vec()
            };
            let pts = if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 {
                i64::try_from(qpc).context("音訊 QPC 時間戳超過範圍")?
            } else {
                now_ticks() - i64::from(frames) * TICKS_PER_SEC / i64::from(self.format.rate)
            };
            Ok(Packet {
                bytes,
                frames,
                flags,
                pts,
            })
        })();
        // SAFETY: 對應上方成功的 GetBuffer，即使檢查／複製失敗也釋放封包。
        unsafe { self.capture.ReleaseBuffer(frames) }.context("釋放 WASAPI 封包失敗")?;
        result
    }
}

impl Drop for EndpointStream {
    fn drop(&mut self) {
        // SAFETY: 介面在同一 COM 執行緒釋放，Stop 之後才釋放事件及 apartment。
        let _ = unsafe { self.client.Stop() };
    }
}

fn read_format(raw: &TaskMem<WAVEFORMATEX>) -> Result<Format> {
    if raw.0.is_null() {
        bail!("裝置沒有回傳音訊格式");
    }
    // SAFETY: GetMixFormat 至少配置完整的 WAVEFORMATEX；使用 unaligned 讀取 packed 結構。
    let format = unsafe { raw.0.read_unaligned() };
    let (float, mask) = if u32::from(format.wFormatTag) == WAVE_FORMAT_EXTENSIBLE {
        if usize::from(format.cbSize)
            < std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>()
        {
            bail!("WAVEFORMATEXTENSIBLE 長度不足");
        }
        // SAFETY: cbSize 已驗證包含完整的擴充格式，且該配置仍有效。
        let extended = unsafe { raw.0.cast::<WAVEFORMATEXTENSIBLE>().read_unaligned() };
        let subformat = extended.SubFormat;
        if subformat != KSDATAFORMAT_SUBTYPE_PCM && subformat != KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
            bail!("不支援的音訊擴充格式");
        }
        (
            subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
            extended.dwChannelMask,
        )
    } else {
        if format.wFormatTag != 1 && u32::from(format.wFormatTag) != WAVE_FORMAT_IEEE_FLOAT {
            bail!("不支援的裝置音訊格式");
        }
        (u32::from(format.wFormatTag) == WAVE_FORMAT_IEEE_FLOAT, 0)
    };
    Format::new(
        format.nSamplesPerSec,
        format.nChannels,
        format.nBlockAlign,
        if float {
            Sample::Float(format.wBitsPerSample)
        } else {
            Sample::Pcm(format.wBitsPerSample)
        },
        mask,
    )
}

struct Packet {
    bytes: Vec<u8>,
    frames: u32,
    flags: u32,
    pts: i64,
}

fn enqueue(sender: &SyncSender<Packet>, packet: Packet, dropped: &AtomicU64) -> bool {
    match sender.try_send(packet) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            dropped.fetch_add(1, Ordering::Relaxed);
            true
        }
        Err(TrySendError::Disconnected(_)) => false,
    }
}

struct Source {
    format: Format,
    packets: Receiver<Packet>,
    resampler: Resampler,
    anchor: Option<i64>,
    input_frames: i64,
    output_frames: i64,
    disconnected: bool,
}

impl Source {
    fn new(format: Format, packets: Receiver<Packet>) -> Self {
        Self {
            resampler: Resampler::new(format.rate),
            format,
            packets,
            anchor: None,
            input_frames: 0,
            output_frames: 0,
            disconnected: false,
        }
    }

    fn drain(&mut self, timeline: &mut Timeline, origin: i64) -> Result<()> {
        for _ in 0..PACKET_CAPACITY {
            let packet = match self.packets.try_recv() {
                Ok(packet) => packet,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.disconnected = true;
                    break;
                }
            };
            self.convert(packet, timeline, origin)?;
        }
        Ok(())
    }

    fn convert(&mut self, packet: Packet, timeline: &mut Timeline, origin: i64) -> Result<()> {
        let expected = self
            .anchor
            .map(|anchor| anchor + self.input_frames * TICKS_PER_SEC / i64::from(self.format.rate));
        let discontinuity = packet.flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0;
        let pts =
            if packet.flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0 && !discontinuity {
                expected.unwrap_or(packet.pts)
            } else {
                packet.pts
            };
        if discontinuity || expected.is_none_or(|expected| (expected - pts).abs() > 20_000) {
            self.anchor = Some(pts);
            self.input_frames = 0;
            self.output_frames = 0;
            self.resampler = Resampler::new(self.format.rate);
        }
        let samples = self.format.decode(
            &packet.bytes,
            packet.frames as usize,
            packet.flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || packet.frames == 0,
        )?;
        let output = self.resampler.push(&samples);
        let anchor = self.anchor.context("音訊時間錨點未初始化")?;
        timeline.write(
            frames_from_ticks(anchor - origin) + self.output_frames,
            &output,
        );
        self.input_frames += i64::from(packet.frames);
        self.output_frames += output.len() as i64;
        Ok(())
    }
}

fn mix_loop(
    mut system: Option<Source>,
    mut mic: Option<Source>,
    origin: i64,
    config: &AudioConfig,
    stop: &AtomicBool,
    mut sink: Box<dyn AudioSink>,
) {
    let cursor = frames_from_ticks(now_ticks() - origin).max(0);
    let mut system_audio = Timeline::new(cursor);
    let mut mic_audio = Timeline::new(cursor);
    loop {
        let result: Result<()> = (|| {
            if let Some(system) = &mut system {
                system.drain(&mut system_audio, origin)?;
            }
            if let Some(mic) = &mut mic {
                mic.drain(&mut mic_audio, origin)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("audio_failed: 音訊格式轉換失敗：{error:#}");
            return;
        }
        let finished = stop.load(Ordering::Acquire)
            || ((system.is_some() || mic.is_some())
                && system.as_ref().is_none_or(|source| source.disconnected)
                && mic.as_ref().is_none_or(|source| source.disconnected));
        let now = frames_from_ticks(now_ticks() - origin);
        while now > system_audio.cursor {
            let frames = if finished {
                BLOCK_FRAMES.min((now - system_audio.cursor) as usize)
            } else {
                BLOCK_FRAMES
            };
            if !finished
                && (system_audio.cursor + frames as i64 > now
                    || (system.is_some() && !system_audio.ready(frames, now, 1440))
                    || (mic.is_some() && !mic_audio.ready(frames, now, 9600)))
            {
                break;
            }
            let pts = ticks_from_frames(system_audio.cursor);
            let samples = mix::mix(
                &system_audio.take(frames),
                &mic_audio.take(frames),
                config.render_gain,
                config.mic_gain,
                config.mic_mono,
            );
            sink.on_audio(&samples, pts);
        }
        if finished {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(pts: i64, flags: u32, value: f32, frames: u32) -> Packet {
        Packet {
            bytes: (0..frames * 2).flat_map(|_| value.to_le_bytes()).collect(),
            frames,
            flags,
            pts,
        }
    }

    #[test]
    fn discontinuity_reanchors_qpc_and_fills_gap_with_silence() {
        let (_, receiver) = mpsc::sync_channel(1);
        let mut source = Source::new(
            Format::new(48_000, 2, 8, Sample::Float(32), 3).unwrap(),
            receiver,
        );
        let origin = 5 * TICKS_PER_SEC;
        let mut timeline = Timeline::new(0);
        source
            .convert(packet(origin, 0, 0.2, 480), &mut timeline, origin)
            .unwrap();
        source
            .convert(
                packet(
                    origin + 300_000,
                    AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32,
                    0.4,
                    480,
                ),
                &mut timeline,
                origin,
            )
            .unwrap();
        assert_eq!(timeline.take(480), vec![[0.2; 2]; 480]);
        assert_eq!(timeline.take(960), vec![[0.0; 2]; 960]);
        assert_eq!(timeline.take(480), vec![[0.4; 2]; 480]);
    }

    #[test]
    fn bad_timestamp_uses_sample_clock_and_dropped_packet_leaves_gap() {
        let (_, receiver) = mpsc::sync_channel(1);
        let mut source = Source::new(
            Format::new(48_000, 2, 8, Sample::Float(32), 3).unwrap(),
            receiver,
        );
        let mut timeline = Timeline::new(0);
        source
            .convert(packet(0, 0, 0.1, 480), &mut timeline, 0)
            .unwrap();
        source
            .convert(
                packet(
                    99_000_000,
                    AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32,
                    0.2,
                    480,
                ),
                &mut timeline,
                0,
            )
            .unwrap();
        source
            .convert(packet(400_000, 0, 0.3, 480), &mut timeline, 0)
            .unwrap();
        assert_eq!(timeline.take(480), vec![[0.1; 2]; 480]);
        assert_eq!(timeline.take(480), vec![[0.2; 2]; 480]);
        assert_eq!(timeline.take(960), vec![[0.0; 2]; 960]);
        assert_eq!(timeline.take(480), vec![[0.3; 2]; 480]);
    }

    #[test]
    fn full_capture_queue_drops_without_waiting_and_counts_packets() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let dropped = AtomicU64::new(0);
        assert!(enqueue(&sender, packet(0, 0, 0.0, 480), &dropped));
        for _ in 0..1000 {
            assert!(enqueue(&sender, packet(0, 0, 0.0, 480), &dropped));
        }
        assert_eq!(dropped.load(Ordering::Relaxed), 1000);
        drop(receiver);
        assert!(!enqueue(&sender, packet(0, 0, 0.0, 480), &dropped));
    }

    #[test]
    fn absent_loopback_and_late_microphone_produce_timed_silence() {
        let (_, packets) = mpsc::sync_channel(1);
        let format = Format::new(48_000, 2, 8, Sample::Float(32), 3).unwrap();
        let source = Source::new(format, packets);
        let system = Timeline::new(0);
        let microphone = Timeline::new(0);
        assert!(!system.ready(480, 1919, 1440));
        assert!(system.ready(480, 1920, 1440));
        assert!(!microphone.ready(480, 10_079, 9600));
        assert!(microphone.ready(480, 10_080, 9600));
        assert!(source.anchor.is_none());
    }
}
