//! 實際 WASAPI 裝置驗證；需要啟用中的預設播放與麥克風裝置。
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
        // SAFETY: 與此測試執行緒成功的初始化配對，所有介面已先釋放。
        unsafe { CoUninitialize() };
    }
}

fn play_tone(stop: &AtomicBool, ready: &mpsc::SyncSender<Result<(), String>>) -> Result<()> {
    // SAFETY: 此測試專用執行緒尚未初始化 COM，結束時以 Com guard 配對。
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok()?;
    let _com = Com;
    // SAFETY: COM 已初始化，僅開啟預設播放端點，不操作其他程序。
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
    // SAFETY: 有效的 float32 立體聲格式，讓 Windows 音訊引擎轉換至實際裝置格式。
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
    // SAFETY: 音訊 client 已成功初始化。
    unsafe { client.Start() }?;
    ready
        .send(Ok(()))
        .map_err(|_| anyhow::anyhow!("測試啟動通道已關閉"))?;
    let mut phase = 0u64;
    while !stop.load(Ordering::Acquire) {
        // SAFETY: client 只在此執行緒操作，padding 不超過 buffer capacity。
        let available = capacity - unsafe { client.GetCurrentPadding() }?;
        if available > 0 {
            // SAFETY: 取得可寫入 available 個 frame 的 buffer，釋放前保持有效。
            let data = unsafe { render.GetBuffer(available) }?;
            // SAFETY: 格式固定為交錯 float32 立體聲，長度為 available * 2 個樣本。
            let samples = unsafe {
                std::slice::from_raw_parts_mut(data.cast::<f32>(), available as usize * 2)
            };
            for pair in samples.chunks_exact_mut(2) {
                let value = (std::f32::consts::TAU * (phase % 48) as f32 / 48.0).sin() * 0.1;
                pair.copy_from_slice(&[value, value]);
                phase += 1;
            }
            // SAFETY: 所有取得的 frame 都已填入資料，與上方 GetBuffer 成對。
            unsafe { render.ReleaseBuffer(available, 0) }?;
        }
        thread::sleep(Duration::from_millis(3));
    }
    // SAFETY: 有效且已啟動的 client，停止後才釋放介面。
    unsafe { client.Stop() }.context("停止測試音源失敗")?;
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
        "兩秒應約 192000 個樣本，實得 {samples}"
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
            "音訊 PTS 不連續：{pair:?}"
        );
        assert_eq!(pair[0].1, 480);
    }
    assert!(recording.blocks[0].0 >= 0);
    eprintln!(
        "實際裝置：{samples} 個交錯樣本，{} 塊，PTS 連續",
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
        .expect("需要預設播放裝置");
    let mic = devices
        .capture
        .iter()
        .find(|device| device.default)
        .expect("需要預設麥克風裝置");
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
    assert!(rms > 0.005, "loopback 未擷取到已播放的測試音，RMS={rms}");
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
    .expect("麥克風啟動失敗時應回傳錯誤並關閉 loopback")
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
        .expect("應回傳錯誤")
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
    // 舊介面未傳 PID，必定觸發回退，與作業系統是否支援此 API 無關。
    let mut capture =
        audio::AudioCapture::start(&cfg, clock::now_ticks(), Box::new(Sink(recording.clone())))
            .unwrap();
    assert!(capture.take_warning().unwrap().contains("已改錄系統聲音"));
    thread::sleep(Duration::from_secs(2));
    capture.stop();
    verify(&recording.lock().unwrap());
}

#[test]
#[ignore = "需要支援程序 loopback 的 Windows 與實際播放裝置；只擷取測試程序自己的聲音"]
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
        capture.take_warning().is_none(),
        "此測試必須實際啟用程序音訊"
    );
    thread::sleep(Duration::from_secs(2));
    capture.stop();
    let recording = recording.lock().unwrap();
    verify(&recording);
    assert!(recording.samples.iter().any(|sample| sample.abs() > 0.005));
}
