//! Validate against real WASAPI devices; requires enabled default playback and microphone devices.
#![allow(dead_code)]

#[path = "../src/audio/mod.rs"]
mod audio;
#[path = "../src/clock.rs"]
mod clock;
#[path = "../src/protocol.rs"]
mod protocol;
#[path = "../src/types.rs"]
mod types;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

#[derive(Default)]
struct Recording {
    samples: Vec<f32>,
    blocks: Vec<(i64, usize)>,
}

struct Sink(Arc<Mutex<Recording>>);

impl audio::AudioSink for Sink {
    fn on_audio(&mut self, samples: &[f32], pts: i64) {
        let mut recording = self.0.lock().unwrap();
        recording.samples.extend_from_slice(samples);
        recording.blocks.push((pts, samples.len() / 2));
    }
}

struct Tone {
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<Result<()>>>,
}

impl Tone {
    fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let result = play_tone(&stopped, &ready_tx);
            if let Err(error) = &result {
                let _ = ready_tx.send(Err(format!("{error:#}")));
            }
            result
        });
        let tone = Self {
            stop,
            worker: Some(worker),
        };
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        tone
    }
}

impl Drop for Tone {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap().unwrap();
        }
    }
}

struct Com;

impl Drop for Com {
    fn drop(&mut self) {
        // SAFETY: Balance successful initialization on this test thread after all interfaces have been released.
        unsafe { CoUninitialize() };
    }
}

fn play_tone(stop: &AtomicBool, ready: &mpsc::SyncSender<Result<(), String>>) -> Result<()> {
    // SAFETY: This dedicated test thread has not initialized COM; the Com guard balances initialization at exit.
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok()?;
    let _com = Com;
    // SAFETY: COM is initialized; only open the default playback endpoint without accessing other processes.
    let client: IAudioClient = unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)?
            .Activate(CLSCTX_ALL, None)?
    };
    let format = WAVEFORMATEX {
        wFormatTag: 3,
        nChannels: 2,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 384_000,
        nBlockAlign: 8,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    // SAFETY: Valid float32 stereo format, converted by the Windows audio engine to the device format.
    let (render, capacity): (IAudioRenderClient, u32) = unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            1_000_000,
            0,
            &format,
            None,
        )?;
        (client.GetService()?, client.GetBufferSize()?)
    };
    // SAFETY: The audio client is initialized.
    unsafe { client.Start() }?;
    ready
        .send(Ok(()))
        .map_err(|_| anyhow::anyhow!("Test startup channel is closed"))?;
    let mut phase = 0u64;
    while !stop.load(Ordering::Acquire) {
        // SAFETY: client is used only on this thread; padding does not exceed buffer capacity.
        let available = capacity - unsafe { client.GetCurrentPadding() }?;
        if available > 0 {
            // SAFETY: Obtain a buffer for available writable frames, valid until released.
            let data = unsafe { render.GetBuffer(available) }?;
            // SAFETY: The format is interleaved float32 stereo with available * 2 samples.
            let samples = unsafe {
                std::slice::from_raw_parts_mut(data.cast::<f32>(), available as usize * 2)
            };
            for pair in samples.chunks_exact_mut(2) {
                let value = (std::f32::consts::TAU * (phase % 48) as f32 / 48.0).sin() * 0.1;
                pair.copy_from_slice(&[value, value]);
                phase += 1;
            }
            // SAFETY: All obtained frames are populated; balance GetBuffer above.
            unsafe { render.ReleaseBuffer(available, 0) }?;
        }
        thread::sleep(Duration::from_millis(3));
    }
    // SAFETY: client is valid and started; release the interface after stopping.
    unsafe { client.Stop() }.context("Failed to stop test audio source")?;
    Ok(())
}

fn record(cfg: &types::AudioConfig) -> Recording {
    let recording = Arc::new(Mutex::new(Recording::default()));
    let capture = audio::AudioCapture::start(
        cfg,
        clock::now_ticks(),
        Box::new(Sink(Arc::clone(&recording))),
    )
    .unwrap();
    thread::sleep(Duration::from_secs(2));
    capture.stop();
    Arc::try_unwrap(recording)
        .ok()
        .unwrap()
        .into_inner()
        .unwrap()
}

fn verify(recording: &Recording) {
    let samples = recording.samples.len();
    assert!(
        (182_400..=201_600).contains(&samples),
        "Expected about 192000 samples over two seconds, got {samples}"
    );
    assert!(recording.blocks.len() >= 190);
    assert!(recording
        .samples
        .iter()
        .all(|sample| sample.is_finite() && (-1.0..=1.0).contains(sample)));
    for pair in recording.blocks.windows(2) {
        let expected = pair[0].0 + pair[0].1 as i64 * clock::TICKS_PER_SEC / 48_000;
        assert!(
            (pair[1].0 - expected).abs() <= 1,
            "Audio PTS is discontinuous: {pair:?}"
        );
        assert_eq!(pair[0].1, 480);
    }
    assert!(recording.blocks[0].0 >= 0);
    eprintln!(
        "Physical device: {samples} interleaved samples in {} blocks, with continuous PTS",
        recording.blocks.len()
    );
}

#[test]
fn actual_default_loopback_and_microphone_capture_for_two_seconds() {
    let devices = audio::list_devices().unwrap();
    let render = devices
        .render
        .iter()
        .find(|device| device.default)
        .expect("Default playback device required");
    let mic = devices
        .capture
        .iter()
        .find(|device| device.default)
        .expect("Default microphone device required");
    assert!(devices
        .render
        .iter()
        .chain(&devices.capture)
        .all(|device| !device.id.is_empty() && !device.name.is_empty()));
    let tone = Tone::start();
    let mut cfg = types::AudioConfig {
        render: "default".into(),
        capture: "停用麥克風時忽略此 ID".into(),
        mic_gain: 1.0,
        mic_enabled: false,
        ..Default::default()
    };
    let loopback = record(&cfg);
    verify(&loopback);
    let rms = (loopback
        .samples
        .iter()
        .map(|sample| sample * sample)
        .sum::<f32>()
        / loopback.samples.len() as f32)
        .sqrt();
    assert!(rms > 0.005, "Loopback did not capture the test tone, RMS={rms}");
    // Excluding this process tree (as Aditor excludes itself) must drop the tone it plays.
    let excluded = record(&types::AudioConfig {
        exclude_pid: Some(std::process::id()),
        ..cfg.clone()
    });
    verify(&excluded);
    let excluded_rms = (excluded.samples.iter().map(|sample| sample * sample).sum::<f32>()
        / excluded.samples.len() as f32)
        .sqrt();
    assert!(
        excluded_rms < rms / 4.,
        "Excluded loopback still captured this process's tone: {excluded_rms} vs {rms}"
    );
    drop(tone);
    cfg.render.clone_from(&render.id);
    cfg.capture = "不存在的麥克風端點".into();
    cfg.mic_enabled = true;
    assert!(audio::AudioCapture::start(
        &cfg,
        clock::now_ticks(),
        Box::new(Sink(Arc::new(Mutex::new(Recording::default())))),
    )
    .err()
    .expect("Microphone startup failure must return an error and close loopback")
    .to_string()
    .starts_with("audio_failed:"));
    cfg.capture.clone_from(&mic.id);
    verify(&record(&cfg));
}

#[test]
fn invalid_configuration_and_endpoint_return_audio_failed() {
    let mut cfg = types::AudioConfig {
        render: "不存在的端點".into(),
        capture: "default".into(),
        mic_gain: 1.0,
        mic_enabled: false,
        ..Default::default()
    };
    let start = |cfg: &types::AudioConfig| {
        audio::AudioCapture::start(
            cfg,
            clock::now_ticks(),
            Box::new(Sink(Arc::new(Mutex::new(Recording::default())))),
        )
        .err()
        .expect("Expected an error")
        .to_string()
    };
    assert!(start(&cfg).starts_with("audio_failed:"));
    cfg.mic_gain = f32::NAN;
    assert!(start(&cfg).starts_with("audio_failed:"));
    cfg.mic_gain = -1.0;
    assert!(start(&cfg).starts_with("audio_failed:"));
}

#[test]
fn disabled_sources_produce_continuous_silent_audio() {
    let cfg = types::AudioConfig {
        render: "停用時不開啟裝置".into(),
        capture: "停用時不開啟裝置".into(),
        render_enabled: false,
        mic_enabled: false,
        ..Default::default()
    };
    let recording = record(&cfg);
    verify(&recording);
    assert!(recording.samples.iter().all(|sample| *sample == 0.0));
}

#[test]
fn unavailable_process_loopback_warns_and_falls_back_to_device() {
    let recording = Arc::new(Mutex::new(Recording::default()));
    let cfg = types::AudioConfig {
        mic_enabled: false,
        render_source: types::RenderSource::Game,
        ..Default::default()
    };
    // The legacy interface supplies no PID, so fallback is guaranteed regardless of OS API support.
    let mut capture =
        audio::AudioCapture::start(&cfg, clock::now_ticks(), Box::new(Sink(recording.clone())))
            .unwrap();
    assert!(capture.drain_warnings()[0].message.contains("switched to system audio"));
    thread::sleep(Duration::from_secs(2));
    capture.stop();
    verify(&recording.lock().unwrap());
}

#[test]
#[ignore = "Requires Windows process loopback support and a physical playback device; captures only the test process audio"]
fn process_loopback_captures_own_audio_and_ignores_render_device() {
    let _tone = Tone::start();
    let cfg = types::AudioConfig {
        render: "程序模式忽略此裝置".into(),
        mic_enabled: false,
        render_source: types::RenderSource::Game,
        ..Default::default()
    };
    let recording = Arc::new(Mutex::new(Recording::default()));
    let mut capture = audio::AudioCapture::start_for_pid(
        &cfg,
        std::process::id(),
        clock::now_ticks(),
        Box::new(Sink(recording.clone())),
    )
    .unwrap();
    assert!(
        capture.drain_warnings().is_empty(),
        "This test must actually enable process audio"
    );
    thread::sleep(Duration::from_secs(2));
    capture.stop();
    let recording = recording.lock().unwrap();
    verify(&recording);
    assert!(recording.samples.iter().any(|sample| sample.abs() > 0.005));
}
