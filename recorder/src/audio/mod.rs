//! WASAPI audio (task B3): system loopback and microphone, each converted to 48 kHz stereo f32,
//! aligned using QPC and mixed into one track (spec §2.4, R7).
//!
//! The scaffold defines the interface; implementations must preserve signatures.

pub mod mix;
mod process;

use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError, TrySendError};
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

/// Called on the audio thread; must not block. `interleaved` is 48 kHz stereo f32; `pts` is the first sample tick.
pub trait AudioSink: Send {
    fn on_audio(&mut self, interleaved: &[f32], pts: i64);
}

pub fn list_devices() -> Result<AudioDevices> {
    let _apartment = Apartment::enter()?;
    let enumerator = enumerator()?;
    // Each flow is listed on its own so one broken endpoint list cannot hide the other.
    Ok(AudioDevices {
        render: devices(&enumerator, eRender).unwrap_or_else(|error| {
            eprintln!("Failed to list audio output devices: {error:#}");
            Vec::new()
        }),
        capture: devices(&enumerator, eCapture).unwrap_or_else(|error| {
            eprintln!("Failed to list audio input devices: {error:#}");
            Vec::new()
        }),
    })
}

pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
    warnings: Receiver<AudioWarning>,
    warning_tx: Sender<AudioWarning>,
}

/// A user-visible audio degradation. The session turns these into one warning event each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioWarning {
    pub code: &'static str,
    pub message: String,
}

/// Missing default endpoints are expected when a device is disabled; explicit bad IDs are not.
fn missing_endpoint(error: &anyhow::Error) -> bool {
    format!("{error:#}").contains("audio_device_missing:")
}

fn missing_endpoint_warning(mic: bool, error: &anyhow::Error) -> AudioWarning {
    let source = if mic { "Microphone" } else { "System audio" };
    AudioWarning {
        code: "audio_device_missing",
        message: format!(
            "{source} is enabled but no matching audio device was found; recording will continue with silence for that source: {error:#}"
        ),
    }
}

fn source_lost_warning(mic: bool, error: &anyhow::Error) -> AudioWarning {
    let source = if mic { "Microphone" } else { "System audio" };
    AudioWarning {
        code: "audio_source_lost",
        message: format!(
            "{source} capture stopped unexpectedly; continuing to record video with silence for that source: {error:#}"
        ),
    }
}

impl AudioCapture {
    /// `origin_ticks`: session start in QPC ticks; emitted pts = sample QPC − origin.
    #[allow(dead_code)] // Keep the existing device capture interface for integration tests.
    pub fn start(cfg: &AudioConfig, origin_ticks: i64, sink: Box<dyn AudioSink>) -> Result<Self> {
        Self::start_for_pid(cfg, 0, origin_ticks, sink)
    }

    pub fn start_for_pid(
        cfg: &AudioConfig,
        pid: u32,
        origin_ticks: i64,
        sink: Box<dyn AudioSink>,
    ) -> Result<Self> {
        cfg.validate().context("audio_failed: Invalid audio parameters")?;
        let (warning_tx, warnings) = mpsc::channel();
        let mut capture = Self {
            stop: Arc::new(AtomicBool::new(false)),
            workers: Vec::new(),
            warnings,
            warning_tx,
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
        let warning_tx = capture.warning_tx.clone();
        // Mix on a separate worker; WASAPI threads only copy packets and try_send without waiting for consumers.
        let worker = thread::Builder::new()
            .name("aditorrec-audio-mix".into())
            .spawn(move || {
                mix_loop(
                    system,
                    mic,
                    origin_ticks,
                    &config,
                    &stop,
                    sink,
                    warning_tx,
                )
            })
            .context("audio_failed: Failed to create mixing thread")?;
        capture.workers.push(worker);
        Ok(capture)
    }

    /// Returns pending warnings in order; startup warnings are queued before this returns.
    pub fn drain_warnings(&mut self) -> Vec<AudioWarning> {
        self.warnings.try_iter().collect()
    }

    /// Legacy single-warning accessor used by the device integration tests.
    pub fn take_warning(&mut self) -> Option<String> {
        self.warnings.try_recv().ok().map(|warning| warning.message)
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
            Err(error) if missing_endpoint(&error) => {
                // Keep the silent AAC track and audio=true metadata; only surface the missing source to the user.
                let _ = self
                    .warning_tx
                    .send(missing_endpoint_warning(mic, &error));
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn spawn_endpoint(&mut self, id: String, mic: bool, pid: Option<u32>) -> Result<Source> {
        let (packets_tx, packets_rx) = mpsc::sync_channel(PACKET_CAPACITY);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let stop = Arc::clone(&self.stop);
        let warning_tx = self.warning_tx.clone();
        let worker = thread::Builder::new()
            .name(
                if mic {
                    "aditorrec-mic"
                } else {
                    "aditorrec-loopback"
                }
                .into(),
            )
            .spawn(move || {
                let opened = if let Some(pid) = pid {
                    EndpointStream::open_process(pid).or_else(|error| {
                        let _ = warning_tx.send(AudioWarning {
                            code: "game_audio_unavailable",
                            message: format!("Game-only audio unavailable; switched to system audio: {error:#}"),
                        });
                        EndpointStream::open(&id, false)
                    })
                } else {
                    EndpointStream::open(&id, mic)
                };
                let stream = match opened {
                    Ok(stream) => stream,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("{error:#}")));
                        return;
                    }
                };
                if ready_tx.send(Ok(stream.format.clone())).is_err() {
                    return;
                }
                let dropped = AtomicU64::new(0);
                if let Err(error) = stream.run(&packets_tx, &stop, &dropped) {
                    // A single endpoint failure only loses that source; the mixer keeps producing silence and video continues.
                    eprintln!("audio_source_lost: Audio capture interrupted: {error:#}");
                    let _ = warning_tx.send(source_lost_warning(mic, &error));
                }
                let dropped = dropped.load(Ordering::Relaxed);
                if dropped != 0 {
                    eprintln!("Audio capture queue dropped {dropped} packets");
                }
            })
            .context("audio_failed: Failed to create audio capture thread")?;
        self.workers.push(worker);
        let format = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .context("audio_failed: Failed to wait for audio device startup")?
            .map_err(|message| anyhow::anyhow!("audio_failed: {message}"))?;
        Ok(Source::new(format, packets_rx))
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Stop both sources and close senders first; the mixing thread drains the queue and fills the tail before exiting.
        for worker in self.workers.drain(..) {
            if worker.join().is_err() {
                eprintln!("audio_failed: Audio thread exited unexpectedly");
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
        // SAFETY: Initialize COM on this thread; successful calls are balanced by Drop on the same thread.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result != RPC_E_CHANGED_MODE {
            result.ok().context("Failed to initialize audio COM")?;
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
            // SAFETY: Only balance the successful CoInitializeEx on this thread.
            unsafe { CoUninitialize() };
        }
    }
}

struct TaskMem<T>(*mut T);

impl<T> Drop for TaskMem<T> {
    fn drop(&mut self) {
        // SAFETY: This pointer only wraps task allocator memory returned by WASAPI/COM and is freed exactly once.
        unsafe { CoTaskMemFree(Some(self.0.cast())) };
    }
}

fn task_string(value: PWSTR) -> Result<String> {
    let memory = TaskMem(value.0);
    // SAFETY: GetId and PropVariantToStringAlloc return valid NUL-terminated UTF-16 allocations.
    unsafe { PWSTR(memory.0).to_string() }.context("Audio device text is not valid UTF-16")
}

fn enumerator() -> Result<IMMDeviceEnumerator> {
    // SAFETY: The caller initialized COM; there is no outer aggregate, and the windows crate manages interfaces.
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
        .context("Failed to create audio device enumerator")
}

fn device_id(device: &IMMDevice) -> Result<String> {
    // SAFETY: device is a valid COM interface; task_string frees the returned allocation.
    task_string(unsafe { device.GetId() }.context("Failed to read audio device ID")?)
}

fn devices(enumerator: &IMMDeviceEnumerator, flow: EDataFlow) -> Result<Vec<AudioDevice>> {
    // SAFETY: The enumerator is valid; only active endpoints and the default endpoint are queried.
    let (collection, default) = unsafe {
        (
            enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)?,
            enumerator.GetDefaultAudioEndpoint(flow, eConsole).ok(),
        )
    };
    // A default endpoint whose ID cannot be read only loses its default mark.
    let default = default.as_ref().and_then(|device| device_id(device).ok());
    // SAFETY: collection is a valid COM collection.
    let count = unsafe { collection.GetCount() }?;
    let mut listed = Vec::with_capacity(count as usize);
    for index in 0..count {
        // SAFETY: index is within the collection.
        let read = unsafe { collection.Item(index) }
            .map_err(anyhow::Error::from)
            .and_then(|device| endpoint(&device, default.as_deref()));
        // Skip only the endpoint that failed; drivers with incomplete properties must not empty the whole list.
        match read {
            Ok(device) => listed.push(device),
            Err(error) => eprintln!("Skipping audio device {index}: {error:#}"),
        }
    }
    Ok(listed)
}

fn endpoint(device: &IMMDevice, default: Option<&str>) -> Result<AudioDevice> {
    let id = device_id(device)?;
    // Some drivers leave the friendly name empty or untyped; fall back to the ID so the device stays selectable.
    let name = friendly_name(device)
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| id.clone());
    Ok(AudioDevice {
        default: default == Some(id.as_str()),
        id,
        name,
    })
}

fn friendly_name(device: &IMMDevice) -> Result<String> {
    // SAFETY: device is a valid COM interface; properties are opened read-only.
    let mut name = unsafe {
        let properties = device.OpenPropertyStore(STGM_READ)?;
        properties.GetValue(&PKEY_Device_FriendlyName)?
    };
    // SAFETY: GetValue initializes name, which is cleared after string conversion regardless of success.
    let text = unsafe { PropVariantToStringAlloc(&name) }
        .map_err(anyhow::Error::from)
        .and_then(task_string);
    // SAFETY: This PROPVARIANT has not been cleared and will not be read again.
    unsafe { PropVariantClear(&mut name) }.context("Failed to release audio device property")?;
    text.context("Failed to read audio device name")
}

struct Event(HANDLE);

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: This handle comes from a successful CreateEventW and is closed exactly once here.
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
            bail!("Audio device ID contains a NUL character");
        }
        let apartment = Apartment::enter()?;
        let enumerator = enumerator()?;
        let wide: Vec<_> = id.encode_utf16().chain(Some(0)).collect();
        // SAFETY: COM is initialized and wide lives until the call returns; only system audio endpoints are used.
        let device = unsafe {
            if id == "default" {
                enumerator.GetDefaultAudioEndpoint(if mic { eCapture } else { eRender }, eConsole)
            } else {
                enumerator.GetDevice(PCWSTR(wide.as_ptr()))
            }
        }
        .map_err(|error| {
            if id == "default" && error.code().0 == 0x80070490u32 as i32 {
                anyhow::anyhow!("audio_device_missing: No default audio device")
            } else {
                anyhow::anyhow!("Specified audio device not found: {error}")
            }
        })?;
        // SAFETY: Activate the valid device's audio interface on this thread.
        let client: IAudioClient =
            unsafe { device.Activate(CLSCTX_ALL, None) }.context("Failed to activate audio device")?;
        // SAFETY: TaskMem owns the GetMixFormat allocation until Initialize returns.
        let raw = TaskMem(unsafe { client.GetMixFormat() }.context("Failed to get device mix format")?);
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
        // SAFETY: Create an auto-reset event owned by this process without a name or security descriptor.
        let event = Event(unsafe { CreateEventW(None, false, false, None) }?);
        let flags =
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK | if mic { 0 } else { AUDCLNT_STREAMFLAGS_LOOPBACK };
        // SAFETY: The format pointer remains valid until Initialize returns; shared event mode uses a zero period.
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
        // SAFETY: client is initialized and its event is configured.
        unsafe { stream.client.Start() }.context("Failed to start audio stream")?;
        Ok(stream)
    }

    fn run(
        &self,
        packets: &SyncSender<Packet>,
        stop: &AtomicBool,
        dropped: &AtomicU64,
    ) -> Result<()> {
        while !stop.load(Ordering::Acquire) {
            // SAFETY: event remains valid throughout the stream lifetime; the 10 ms timeout handles silent loopback.
            if unsafe { WaitForSingleObject(self.event.0, 10) } == WAIT_FAILED {
                return Err(windows::core::Error::from_thread().into());
            }
            loop {
                // SAFETY: capture is started and accessed only on this thread.
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
        // SAFETY: All output pointers are valid; GetBuffer/ReleaseBuffer are paired on this thread only.
        unsafe {
            self.capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))
        }?;
        let result = (|| {
            if frames > self.buffer_frames {
                bail!("WASAPI packet exceeds device buffer size");
            }
            let bytes = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || frames == 0 {
                Vec::new()
            } else {
                if data.is_null() {
                    bail!("WASAPI returned a null audio data pointer");
                }
                let length = frames as usize * self.format.block_align;
                // SAFETY: GetBuffer guarantees frames complete frames, and the pointer is valid until ReleaseBuffer.
                unsafe { std::slice::from_raw_parts(data, length) }.to_vec()
            };
            let pts = if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 {
                i64::try_from(qpc).context("Audio QPC timestamp is out of range")?
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
        // SAFETY: Balance the successful GetBuffer above, releasing the packet even if validation or copying fails.
        unsafe { self.capture.ReleaseBuffer(frames) }.context("Failed to release WASAPI packet")?;
        result
    }
}

impl Drop for EndpointStream {
    fn drop(&mut self) {
        // SAFETY: Interfaces are released on the same COM thread; release the event and apartment after Stop.
        let _ = unsafe { self.client.Stop() };
    }
}

fn read_format(raw: &TaskMem<WAVEFORMATEX>) -> Result<Format> {
    if raw.0.is_null() {
        bail!("Device returned no audio format");
    }
    // SAFETY: GetMixFormat allocates at least a complete WAVEFORMATEX; read the packed structure unaligned.
    let format = unsafe { raw.0.read_unaligned() };
    let (float, mask) = if u32::from(format.wFormatTag) == WAVE_FORMAT_EXTENSIBLE {
        if usize::from(format.cbSize)
            < std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>()
        {
            bail!("WAVEFORMATEXTENSIBLE is too short");
        }
        // SAFETY: cbSize includes the complete extended format and the allocation remains valid.
        let extended = unsafe { raw.0.cast::<WAVEFORMATEXTENSIBLE>().read_unaligned() };
        let subformat = extended.SubFormat;
        if subformat != KSDATAFORMAT_SUBTYPE_PCM && subformat != KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
            bail!("Unsupported extended audio format");
        }
        (
            subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
            extended.dwChannelMask,
        )
    } else {
        if format.wFormatTag != 1 && u32::from(format.wFormatTag) != WAVE_FORMAT_IEEE_FLOAT {
            bail!("Unsupported device audio format");
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
        }
    }

    fn drain(&mut self, timeline: &mut Timeline, origin: i64) -> Result<()> {
        for _ in 0..PACKET_CAPACITY {
            let packet = match self.packets.try_recv() {
                Ok(packet) => packet,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
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
        let anchor = self.anchor.context("Audio time anchor is not initialized")?;
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
    warnings: Sender<AudioWarning>,
) {
    let cursor = frames_from_ticks(now_ticks() - origin).max(0);
    let mut system_audio = Timeline::new(cursor);
    let mut mic_audio = Timeline::new(cursor);
    loop {
        let system_error = system
            .as_mut()
            .and_then(|source| source.drain(&mut system_audio, origin).err());
        if let Some(error) = system_error {
            eprintln!("audio_source_lost: System audio conversion failed: {error:#}");
            let _ = warnings.send(source_lost_warning(false, &error));
            system = None;
        }
        let mic_error = mic
            .as_mut()
            .and_then(|source| source.drain(&mut mic_audio, origin).err());
        if let Some(error) = mic_error {
            eprintln!("audio_source_lost: Microphone conversion failed: {error:#}");
            let _ = warnings.send(source_lost_warning(true, &error));
            mic = None;
        }
        // Continue until the session stops: when all sources are gone we still emit silence so audio and video stay aligned.
        let finished = stop.load(Ordering::Acquire);
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
    use std::sync::Mutex;

    fn packet(pts: i64, flags: u32, value: f32, frames: u32) -> Packet {
        Packet {
            bytes: (0..frames * 2).flat_map(|_| value.to_le_bytes()).collect(),
            frames,
            flags,
            pts,
        }
    }

    fn broken_packet(pts: i64) -> Packet {
        Packet {
            bytes: vec![0; 4],
            frames: 1,
            flags: 0,
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

    #[test]
    fn missing_default_endpoint_warns_but_explicit_missing_device_stays_fatal() {
        let default = anyhow::anyhow!("audio_failed: audio_device_missing: No default audio device");
        assert!(missing_endpoint(&default));
        let warning = missing_endpoint_warning(false, &default);
        assert_eq!(warning.code, "audio_device_missing");
        assert!(warning.message.contains("System audio"));
        assert!(missing_endpoint_warning(true, &default)
            .message
            .contains("Microphone"));

        let explicit = anyhow::anyhow!("audio_failed: Specified audio device not found: 0x80070002");
        assert!(!missing_endpoint(&explicit));
    }

    #[test]
    fn runtime_source_loss_warning_names_the_failed_source() {
        let error = anyhow::anyhow!("WASAPI GetBuffer failed");
        let system = source_lost_warning(false, &error);
        assert_eq!(system.code, "audio_source_lost");
        assert!(system.message.contains("System audio"));
        assert!(system.message.contains("continuing to record video"));
        assert!(source_lost_warning(true, &error)
            .message
            .contains("Microphone"));
    }

    struct Collect(Arc<Mutex<Vec<Vec<f32>>>>);

    impl AudioSink for Collect {
        fn on_audio(&mut self, interleaved: &[f32], _pts: i64) {
            self.0.lock().unwrap().push(interleaved.to_vec());
        }
    }

    #[test]
    fn source_loss_keeps_emitting_silence_until_the_session_stops() {
        let (sender, packets) = mpsc::sync_channel(PACKET_CAPACITY);
        let format = Format::new(48_000, 2, 8, Sample::Float(32), 3).unwrap();
        let source = Source::new(format, packets);
        let origin = now_ticks();
        // Cover startup scheduling delay; once these packets are consumed the producer is gone.
        for slot in 0..10 {
            let pts = origin + slot * TICKS_PER_SEC / 100;
            sender.send(packet(pts, 0, 0.25, 480)).unwrap();
        }
        drop(sender);

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let blocks = Arc::new(Mutex::new(Vec::new()));
        let worker_blocks = blocks.clone();
        let (warnings, observed) = mpsc::channel();
        let worker = thread::spawn(move || {
            mix_loop(
                Some(source),
                None,
                origin,
                &AudioConfig::default(),
                &worker_stop,
                Box::new(Collect(worker_blocks)),
                warnings,
            );
        });
        thread::sleep(Duration::from_millis(250));
        stop.store(true, Ordering::Release);
        worker.join().unwrap();

        let blocks = blocks.lock().unwrap();
        assert!(blocks.len() >= 4, "expected continued mixing, got {}", blocks.len());
        assert!(
            blocks.iter().any(|block| block.iter().any(|sample| *sample != 0.0)),
            "the packet received before the loss must still be audible"
        );
        assert!(
            blocks.last().unwrap().iter().all(|sample| *sample == 0.0),
            "the mixer must fill the lost source with silence"
        );
        assert!(
            observed.try_recv().is_err(),
            "normal sender teardown is not an audio failure"
        );
    }

    #[test]
    fn one_lost_source_keeps_the_other_source_audible() {
        let format = Format::new(48_000, 2, 8, Sample::Float(32), 3).unwrap();
        let (system_sender, system_packets) = mpsc::sync_channel(PACKET_CAPACITY);
        let (mic_sender, mic_packets) = mpsc::sync_channel(PACKET_CAPACITY);
        let origin = now_ticks();
        system_sender
            .send(packet(origin, 0, 0.25, 480))
            .unwrap();
        system_sender
            .send(broken_packet(origin + TICKS_PER_SEC / 100))
            .unwrap();
        drop(system_sender);
        // Keep the microphone alive long enough to prove it still reaches the mixer after the system source dies.
        for slot in 0..20 {
            let pts = origin + slot * TICKS_PER_SEC / 100;
            mic_sender
                .send(packet(pts, 0, 0.5, 480))
                .unwrap();
        }
        drop(mic_sender);

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let blocks = Arc::new(Mutex::new(Vec::new()));
        let worker_blocks = blocks.clone();
        let (warnings, observed) = mpsc::channel();
        let worker = thread::spawn(move || {
            mix_loop(
                Some(Source::new(format.clone(), system_packets)),
                Some(Source::new(format, mic_packets)),
                origin,
                &AudioConfig::default(),
                &worker_stop,
                Box::new(Collect(worker_blocks)),
                warnings,
            );
        });
        thread::sleep(Duration::from_millis(300));
        stop.store(true, Ordering::Release);
        worker.join().unwrap();

        let warnings: Vec<_> = observed.try_iter().collect();
        assert_eq!(warnings.len(), 1, "only the broken system source must warn");
        assert_eq!(warnings[0].code, "audio_source_lost");
        assert!(warnings[0].message.contains("System audio"));

        let blocks = blocks.lock().unwrap();
        assert!(
            blocks.len() >= 10,
            "expected the microphone to keep mixing, got {} blocks",
            blocks.len()
        );
        assert!(
            blocks
                .iter()
                .any(|block| block.iter().any(|sample| (*sample - 0.5).abs() < 1e-6)),
            "the surviving microphone source must remain audible"
        );
        assert!(
            blocks.last().unwrap().iter().all(|sample| *sample == 0.0),
            "after its buffer is exhausted the lost source must be filled with silence"
        );
    }

    #[test]
    fn both_lost_sources_keep_emitting_silence_until_stop() {
        let format = Format::new(48_000, 2, 8, Sample::Float(32), 3).unwrap();
        let (system_sender, system_packets) = mpsc::sync_channel(PACKET_CAPACITY);
        let (mic_sender, mic_packets) = mpsc::sync_channel(PACKET_CAPACITY);
        let origin = now_ticks();
        system_sender.send(broken_packet(origin)).unwrap();
        drop(system_sender);
        mic_sender.send(broken_packet(origin)).unwrap();
        drop(mic_sender);

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let blocks = Arc::new(Mutex::new(Vec::new()));
        let worker_blocks = blocks.clone();
        let (warnings, observed) = mpsc::channel();
        let worker = thread::spawn(move || {
            mix_loop(
                Some(Source::new(format.clone(), system_packets)),
                Some(Source::new(format, mic_packets)),
                origin,
                &AudioConfig::default(),
                &worker_stop,
                Box::new(Collect(worker_blocks)),
                warnings,
            );
        });
        thread::sleep(Duration::from_millis(250));
        stop.store(true, Ordering::Release);
        worker.join().unwrap();

        let warnings: Vec<_> = observed.try_iter().collect();
        assert_eq!(warnings.len(), 2);
        assert!(warnings.iter().all(|warning| warning.code == "audio_source_lost"));
        assert!(warnings.iter().any(|warning| warning.message.contains("System audio")));
        assert!(warnings.iter().any(|warning| warning.message.contains("Microphone")));

        let blocks = blocks.lock().unwrap();
        assert!(
            blocks.len() >= 10,
            "the mixer must keep advancing after every source is lost, got {} blocks",
            blocks.len()
        );
        assert!(blocks.iter().all(|block| block.iter().all(|sample| *sample == 0.0)));
    }
}
