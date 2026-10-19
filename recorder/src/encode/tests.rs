use std::{
    fs,
    io::Write,
    process::Command,
    sync::atomic::AtomicUsize,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

use super::*;

static GPU_TEST: Mutex<()> = Mutex::new(());
static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

#[test]
fn worker_failures_are_latched_without_further_frames() {
    let counts = Counts::default();
    monitor_worker(&counts, || Ok(())).unwrap();
    assert!(counts.check_error().is_ok());
    assert!(monitor_worker(&counts, || bail!("測試封裝失敗")).is_err());
    counts.fail("後續錯誤");
    assert_eq!(counts.error.get().unwrap(), "測試封裝失敗");
    assert!(counts
        .check_error()
        .unwrap_err()
        .to_string()
        .contains("測試封裝失敗"));
}

#[test]
fn worker_panics_are_latched_as_encode_errors() {
    let counts = Counts::default();
    assert!(monitor_worker(&counts, || panic!("測試編碼 panic")).is_err());
    assert!(counts
        .check_error()
        .unwrap_err()
        .to_string()
        .starts_with("encode_failed:"));
}

fn params(codec: Codec) -> VideoParams {
    VideoParams {
        width: 1280,
        height: 720,
        fps: 60,
        codec,
        encoder: "auto".into(),
        bitrate_kbps: 4000,
        preset: EncodePreset::Speed,
        aspect: EncodeAspect::Native,
    }
}
fn temp_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "apexrec-encode-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_DIR.fetch_add(1, Ordering::Relaxed)
    ))
}
fn executable(name: &str) -> std::path::PathBuf {
    std::env::var_os("APEXREC_FFMPEG_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../build/ffmpeg"))
        .join("bin")
        .join(format!("{name}.exe"))
}
fn inspect(path: &Path) -> serde_json::Value {
    let output = Command::new(executable("ffprobe"))
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-show_packets",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn texture(gpu: &Gpu, size: (u32, u32)) -> (ID3D11Texture2D, ID3D11RenderTargetView) {
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
    // SAFETY: 有效裝置、單層 BGRA 描述及由 windows crate 管理的輸出參照。
    unsafe {
        gpu.device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .unwrap();
        gpu.device
            .CreateRenderTargetView(texture.as_ref().unwrap(), None, Some(&mut view))
            .unwrap();
    }
    (texture.unwrap(), view.unwrap())
}
fn concatenate(dir: &Path, segments: &[SegmentInfo], path: &Path) {
    let mut output = fs::File::create(path).unwrap();
    output
        .write_all(&fs::read(dir.join("init.mp4")).unwrap())
        .unwrap();
    for segment in segments {
        output
            .write_all(&fs::read(dir.join(format!("seg_{:06}.m4s", segment.seq))).unwrap())
            .unwrap();
    }
}

#[test]
fn encoder_selection_preserves_vendor_order_and_hevc_fallback() {
    let mut video = params(Codec::Hevc);
    assert_eq!(
        candidates(&video),
        [
            "hevc_nvenc",
            "hevc_amf",
            "hevc_qsv",
            "h264_nvenc",
            "h264_amf",
            "h264_qsv"
        ]
    );
    video.codec = Codec::Av1;
    assert_eq!(candidates(&video), ["av1_nvenc", "av1_amf", "av1_qsv"]);
    video.encoder = "libx264".into();
    assert!(candidates(&video).is_empty());
    video.encoder = "h264_nvenc".into();
    assert!(candidates(&video).is_empty());
    video.codec = Codec::H264;
    assert_eq!(candidates(&video), ["h264_nvenc"]);
}

#[test]
fn cfr_ticks_do_not_accumulate_rounding_error() {
    for fps in [24, 60, 144] {
        assert_eq!(frame_tick(fps as i64 * 3600, fps), 36_000_000_000);
        assert_eq!(frame_tick(fps as i64 * 2, fps), 20_000_000);
    }
}

#[test]
fn aac_fifo_aligns_gaps_overlaps_and_partial_frames() {
    let mut audio = aac::Audio::new().unwrap();
    let mut packets = audio.push(&vec![0.1; 960], 100_000).unwrap();
    packets.extend(audio.push(&vec![0.1; 960], 100_000).unwrap()); // 重複塊應丟棄。
    packets.extend(audio.push(&vec![0.2; 960], 300_000).unwrap()); // 中間 10 ms 靜音。
    packets.extend(audio.finish(400_000).unwrap());
    let times: Vec<_> = packets
        .iter()
        .map(|p| {
            // SAFETY: 測試持有有效封包，僅讀取時間戳。
            unsafe { (*p.0).pts }
        })
        .collect();
    assert_eq!(times, [-1024, 0, 1024]);
}

fn record(
    gpu: &Gpu,
    source_size: (u32, u32),
    name: &str,
    audio_enabled: bool,
    frame_count: i64,
    skip: bool,
) {
    let dir = temp_dir();
    let mut video = params(codec_of(name));
    video.encoder = name.into();
    let (tx, rx) = mpsc::channel();
    let writer = SegmentWriter::open(gpu, &dir, video, audio_enabled, tx).unwrap();
    assert_eq!(writer.encoder_name(), name);
    assert!(dir.join("init.mp4").metadata().unwrap().len() > 0);
    let (source, view) = texture(gpu, source_size);
    let started = Instant::now();
    let mut delivered_live = false;
    let mut segments = Vec::new();
    for slot in 0..frame_count {
        if audio_enabled {
            let samples: Vec<_> = (0..800)
                .flat_map(|i| {
                    let value =
                        (std::f32::consts::TAU * 440. * ((slot * 800 + i) as f32) / 48_000.).sin()
                            * 0.2;
                    [value, value]
                })
                .collect();
            writer.push_audio(&samples, frame_tick(slot, 60));
        }
        if !skip || !(90..105).contains(&slot) {
            let color = if slot < 120 {
                [0.8, (slot % 128) as f32 / 255., 0.1, 1.]
            } else {
                [0.1, (slot % 128) as f32 / 255., 0.8, 1.]
            };
            // SAFETY: RTV 與來源 texture 同裝置；D3D11 context 已啟用 multithread 保護。
            unsafe {
                gpu.context.ClearRenderTargetView(&view, &color);
            }
            assert_eq!(
                writer.push_video(&source, source_size.0, source_size.1, frame_tick(slot, 60)),
                PushResult::Queued,
                "slot={slot}"
            );
            if slot == 0 {
                assert_eq!(
                    writer.push_video(&source, source_size.0, source_size.1, 0),
                    PushResult::Dropped
                );
            }
        }
        while let Ok(info) = rx.try_recv() {
            let file = dir.join(format!("seg_{:06}.m4s", info.seq));
            assert_eq!(file.metadata().unwrap().len(), info.bytes);
            delivered_live = true;
            segments.push(info);
        }
        let deadline = Duration::from_secs_f64((slot + 1) as f64 / 60.);
        if let Some(wait) = deadline.checked_sub(started.elapsed()) {
            thread::sleep(wait);
        }
    }
    writer.finish().unwrap();
    segments.extend(rx.try_iter());
    if frame_count >= 240 {
        assert!(delivered_live, "必須在 finish 前送出完整段落");
    }
    let expected_segments = (frame_count + 119) / 120;
    assert_eq!(segments.len() as i64, expected_segments);
    for (i, segment) in segments.iter().enumerate() {
        assert_eq!(
            fs::metadata(dir.join(format!("seg_{:06}.m4s", segment.seq)))
                .unwrap()
                .len(),
            segment.bytes
        );
        assert_eq!(segment.seq, i as u64 + 1);
        assert!((segment.pts_secs - i as f64 * 2.).abs() < 0.001);
        let expected = ((frame_count as f64 / 60.) - i as f64 * 2.).min(2.);
        assert!((segment.dur_secs - expected).abs() < 0.05, "{segment:?}");
        let single = dir.join(format!("verify-{}.mp4", segment.seq));
        concatenate(&dir, std::slice::from_ref(segment), &single);
        let json = inspect(&single);
        let packets = json["packets"].as_array().unwrap();
        let first = packets.iter().find(|p| p["stream_index"] == 0).unwrap();
        assert!(first["flags"].as_str().unwrap().contains('K'));
        let duration: f64 = packets
            .iter()
            .filter(|p| p["stream_index"] == 0)
            .map(|p| p["duration_time"].as_str().unwrap().parse::<f64>().unwrap())
            .sum();
        assert!((duration - expected).abs() < 0.05, "實際段長={duration}");
    }
    let combined = dir.join("combined.mp4");
    concatenate(&dir, &segments, &combined);
    let json = inspect(&combined);
    let streams = json["streams"].as_array().unwrap();
    assert_eq!(streams.len(), if audio_enabled { 2 } else { 1 });
    assert_eq!(streams[0]["width"], 1280);
    assert_eq!(streams[0]["height"], 720);
    if audio_enabled {
        assert_eq!(streams[1]["codec_name"], "aac");
        assert_eq!(streams[1]["sample_rate"], "48000");
        assert_eq!(streams[1]["channels"], 2);
        let sound = Command::new(executable("ffmpeg"))
            .args(["-v", "error", "-i"])
            .arg(&combined)
            .args(["-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"])
            .output()
            .unwrap();
        assert!(
            sound.status.success(),
            "{}",
            String::from_utf8_lossy(&sound.stderr)
        );
        let samples: Vec<_> = sound
            .stdout
            .chunks_exact(8)
            .map(|s| f32::from_le_bytes(s[..4].try_into().unwrap()))
            .collect();
        let interval = &samples[4800..48_000];
        let crossings = interval
            .windows(2)
            .filter(|s| s[0] <= 0. && s[1] > 0.)
            .count();
        let frequency = crossings as f64 / (interval.len() as f64 / 48_000.);
        assert!((frequency - 440.).abs() < 3., "AAC 解碼頻率={frequency}");
        let rms = (interval.iter().map(|s| s * s).sum::<f32>() / interval.len() as f32).sqrt();
        assert!((rms - 0.2 / 2f32.sqrt()).abs() < 0.02, "AAC 解碼振幅={rms}");
    }
    let duration = json["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!(
        (duration - frame_count as f64 / 60.).abs() < 0.2,
        "總時長={duration}"
    );
    let packets: Vec<_> = json["packets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["stream_index"] == 0)
        .collect();
    assert_eq!(packets.len() as i64, frame_count);
    for (i, p) in packets.iter().enumerate() {
        let pts = p["pts_time"].as_str().unwrap().parse::<f64>().unwrap();
        assert!((pts - i as f64 / 60.).abs() < 0.00001);
    }
    let decode = Command::new(executable("ffmpeg"))
        .args(["-v", "error", "-i"])
        .arg(&combined)
        .args(["-f", "null", "-"])
        .output()
        .unwrap();
    assert!(
        decode.status.success() && decode.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&decode.stderr)
    );
    // 真正解碼前後色塊，驗證 GPU 複製／縮放不是黑畫面或使用已覆寫的表面。
    let pixels = Command::new(executable("ffmpeg"))
        .args(["-v", "error", "-i"])
        .arg(&combined)
        .args([
            "-vf",
            "select=eq(n\\,0)+eq(n\\,120),scale=1:1",
            "-fps_mode",
            "passthrough",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-",
        ])
        .output()
        .unwrap();
    assert!(
        pixels.status.success(),
        "{}",
        String::from_utf8_lossy(&pixels.stderr)
    );
    assert!(
        pixels.stdout[0] > pixels.stdout[2] + 80,
        "首格必須是紅色：{:?}",
        pixels.stdout
    );
    for (&actual, expected) in pixels.stdout[..3].iter().zip([204u8, 0, 26]) {
        assert!(
            actual.abs_diff(expected) <= 8,
            "首格色彩應保留：{:?}",
            pixels.stdout
        );
    }
    if frame_count > 120 {
        assert!(
            pixels.stdout[5] > pixels.stdout[3] + 80,
            "第二段必須是藍色：{:?}",
            pixels.stdout
        );
    }
    eprintln!(
        "{name}：來源 {source_size:?}，{} 段，{duration:.3} 秒，解碼成功",
        segments.len()
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn gpu_recording_and_scaling_have_independent_keyframe_segments() {
    let _guard = GPU_TEST.lock().unwrap();
    let gpu = Gpu::create().unwrap();
    let names = SegmentWriter::probe_encoders(&gpu);
    eprintln!("實際試編碼可用編碼器：{names:?}");
    assert!(
        names.iter().any(|name| name == "hevc_nvenc"),
        "本機 RTX 5080 應可使用 HEVC NVENC"
    );
    record(&gpu, (1280, 720), "hevc_nvenc", true, 300, false);
    record(&gpu, (1920, 1080), "hevc_nvenc", true, 300, true);
    for name in ["h264_nvenc", "av1_nvenc"] {
        assert!(names.iter().any(|available| available == name));
        record(&gpu, (1280, 720), name, false, 120, false);
    }
}

#[test]
fn gpu_nv12_conversion_and_error_propagation() {
    let _guard = GPU_TEST.lock().unwrap();
    let gpu = Gpu::create().unwrap();
    let video = params(Codec::Hevc);
    let hardware = Hardware::new(&gpu, &video, ffi::AV_PIX_FMT_NV12).unwrap();
    let encoder = hardware.encoder("hevc_nvenc", &video).unwrap();
    let frame = hardware.surface().unwrap();
    let (source, view) = texture(&gpu, (1920, 1080));
    // SAFETY: 有效的同裝置 RTV。
    unsafe {
        gpu.context
            .ClearRenderTargetView(&view, &[0.8, 0.1, 0.1, 1.]);
    }
    Copier::new(&gpu, &video, hardware.format)
        .copy(&source, (1920, 1080), &frame)
        .unwrap();
    // SAFETY: 本測試獨佔影格 metadata。
    unsafe {
        (*frame.0).pts = 0;
        (*frame.0).duration = 166_667;
    }
    let dir = temp_dir();
    let (tx, rx) = mpsc::channel();
    let mut muxer = mux::Muxer::new(&dir, &encoder, None, tx).unwrap();
    let mut packets = encoder.send(Some(&frame)).unwrap();
    packets.extend(encoder.send(None).unwrap());
    assert!(!packets.is_empty());
    // SAFETY: 封包在測試中獨佔，為單格錄影補上明確長度。
    unsafe {
        for packet in &packets {
            (*packet.0).duration = 166_667;
        }
    }
    muxer.push(packets, true).unwrap();
    muxer.finish().unwrap();
    drop(muxer);
    let combined = dir.join("nv12.mp4");
    concatenate(&dir, &rx.try_iter().collect::<Vec<_>>(), &combined);
    let pixels = Command::new(executable("ffmpeg"))
        .args(["-v", "error", "-i"])
        .arg(&combined)
        .args([
            "-vf",
            "scale=1:1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-",
        ])
        .output()
        .unwrap();
    assert!(
        pixels.status.success(),
        "{}",
        String::from_utf8_lossy(&pixels.stderr)
    );
    assert_eq!(pixels.stdout.len(), 3);
    assert!(
        pixels.stdout[0] > pixels.stdout[2] + 80,
        "NV12 轉換顏色錯誤：{:?}",
        pixels.stdout
    );
    for (&actual, expected) in pixels.stdout.iter().zip([204u8, 26, 26]) {
        assert!(
            actual.abs_diff(expected) <= 8,
            "NV12 色彩應保留：{:?}",
            pixels.stdout
        );
    }
    fs::remove_dir_all(dir).unwrap();

    // 模擬編碼執行緒停滯，確認 8 格滿載後呼叫仍立即回傳。
    let (tx, rx) = mpsc::sync_channel(QUEUE_SIZE);
    let pool = (0..POOL_SIZE)
        .map(|_| {
            Arc::new(Surface {
                frame: hardware.surface().unwrap(),
            })
        })
        .collect();
    let stalled = SegmentWriter {
        name: "hevc_nvenc".into(),
        producer: Mutex::new(Producer {
            copier: Copier::new(&gpu, &video, hardware.format),
            pool,
            last_slot: None,
            fps: 60,
        }),
        video_tx: Some(tx),
        audio_tx: None,
        counts: Arc::new(Counts::default()),
        worker: None,
    };
    for slot in 0..8 {
        assert_eq!(
            stalled.push_video(&source, 1920, 1080, frame_tick(slot, 60)),
            PushResult::Queued
        );
    }
    let start = Instant::now();
    assert_eq!(
        stalled.push_video(&source, 1920, 1080, frame_tick(8, 60)),
        PushResult::Dropped
    );
    assert!(start.elapsed() < Duration::from_millis(100));
    assert!(stalled.check_error().is_ok());
    assert_eq!(
        stalled.stats(),
        EncodeStats {
            frames_in: 9,
            frames_encoded: 0,
            dropped: 1,
            queue_len: 8
        }
    );
    drop(stalled);
    assert_eq!(rx.try_iter().count(), 8);

    let dir = temp_dir();
    let (tx, _rx) = mpsc::channel();
    let writer = SegmentWriter::open(&gpu, &dir, video.clone(), false, tx).unwrap();
    let lock = writer.producer.lock().unwrap();
    assert_eq!(
        writer.push_video(&source, 1920, 1080, 0),
        PushResult::Dropped
    );
    drop(lock);
    assert_eq!(
        writer.push_video(&source, 1920, 1080, 0),
        PushResult::Queued
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while writer.stats().frames_encoded == 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(writer.stats().frames_encoded > 0);
    assert_eq!(
        writer.push_video(&source, 100, 100, frame_tick(1, 60)),
        PushResult::Dropped
    );
    assert!(writer
        .check_error()
        .unwrap_err()
        .to_string()
        .contains("GPU"));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !writer.worker.as_ref().unwrap().is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        writer.worker.as_ref().unwrap().is_finished(),
        "複製失敗後必須停止 CFR 補格"
    );
    assert!(writer.finish().unwrap_err().to_string().contains("GPU"));
    fs::remove_dir_all(dir).unwrap();

    let dir = temp_dir();
    let mut software = video.clone();
    software.encoder = "libx264".into();
    let (tx, _rx) = mpsc::channel();
    let result = SegmentWriter::open(&gpu, &dir, software, false, tx);
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .starts_with("no_hw_encoder:"));
    assert!(!dir.exists());
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("init.mp4"), "既有錄影".as_bytes()).unwrap();
    let (tx, _rx) = mpsc::channel();
    assert!(SegmentWriter::open(&gpu, &dir, video, false, tx).is_err());
    assert_eq!(
        fs::read(dir.join("init.mp4")).unwrap(),
        "既有錄影".as_bytes()
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn gpu_static_capture_keeps_cfr_and_silent_audio_running() {
    let _guard = GPU_TEST.lock().unwrap();
    let gpu = Gpu::create().unwrap();
    let dir = temp_dir();
    let mut video = params(Codec::Hevc);
    video.encoder = "hevc_nvenc".into();
    let (tx, rx) = mpsc::channel();
    let writer = SegmentWriter::open(&gpu, &dir, video, true, tx).unwrap();
    let (source, view) = texture(&gpu, (1280, 720));
    // SAFETY: 同裝置的有效 RTV，只在測試中設定已知色塊。
    unsafe {
        gpu.context
            .ClearRenderTargetView(&view, &[0.8, 0.1, 0.1, 1.]);
    }
    assert_eq!(writer.push_video(&source, 1280, 720, 0), PushResult::Queued);
    // 模擬 WGC 靜止畫面不再送格，且 WASAPI 沒有音訊塊。
    thread::sleep(Duration::from_millis(2600));
    assert_eq!(writer.stats().frames_in, 1);
    assert!(writer.stats().frames_encoded >= 120);
    let mut segments: Vec<_> = rx.try_iter().collect();
    assert!(!segments.is_empty(), "靜止畫面也必須在錄影期間完成段落");
    writer.finish().unwrap();
    segments.extend(rx.try_iter());
    assert_eq!(segments.len(), 2);
    let combined = dir.join("static.mp4");
    concatenate(&dir, &segments, &combined);
    let json = inspect(&combined);
    assert_eq!(json["streams"].as_array().unwrap().len(), 2);
    let duration = json["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!((duration - 2.6).abs() < 0.1, "靜止畫面錄影時長={duration}");
    let silence = Command::new(executable("ffmpeg"))
        .args(["-v", "error", "-i"])
        .arg(&combined)
        .args(["-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"])
        .output()
        .unwrap();
    assert!(silence.status.success());
    assert!(silence
        .stdout
        .chunks_exact(4)
        .all(|s| f32::from_le_bytes(s.try_into().unwrap()).abs() < 0.0001));
    fs::remove_dir_all(dir).unwrap();
}
