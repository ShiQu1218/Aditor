use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::Command,
    sync::atomic::AtomicUsize,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use windows::core::Interface;
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

use super::*;

static GPU_TEST: Mutex<()> = Mutex::new(());
static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

fn ffmpeg_failure(code: i32) -> anyhow::Error {
    anyhow::Error::from(ffmpeg::FfmpegError::new(
        code,
        format!("Open encoder failed: test ({code})"),
    ))
    .context("Trial encoding failed")
}

#[test]
fn nvenc_not_implemented_with_old_driver_api_flags_outdated_nvidia_driver() {
    let failures = [
        ("hevc_nvenc", ffmpeg_failure(ffmpeg::NOT_IMPLEMENTED)),
        ("hevc_amf", ffmpeg_failure(-1313558101)),
    ];
    let message = no_hw_encoder_message(&failures, || Some((12, 2)));
    assert!(message.starts_with("no_hw_encoder: nvidia_driver_outdated:"));
    assert!(message.contains("NVENC API 12.2 but 13.0 is required"));
    assert!(message.contains("570.0 or newer"));
    assert!(message.contains("hevc_nvenc: Trial encoding failed: Open encoder failed: test (-40)"));
    assert!(message.contains("；hevc_amf: "));
}

#[test]
fn nvenc_not_implemented_with_current_driver_is_not_blamed_on_the_driver() {
    // Unsupported GPUs (no NVENC, or no HEVC encoder) also return ENOSYS; a current driver must not get the hint.
    let failures = [("hevc_nvenc", ffmpeg_failure(ffmpeg::NOT_IMPLEMENTED))];
    for driver_api in [Some(nvenc::REQUIRED_API), Some((13, 1)), None] {
        let message = no_hw_encoder_message(&failures, || driver_api);
        assert!(message.starts_with("no_hw_encoder: No hardware encoder is available;"));
    }
}

#[test]
fn other_failures_keep_generic_message_without_querying_the_driver() {
    let failures = [
        ("hevc_nvenc", ffmpeg_failure(-1313558101)),
        ("hevc_amf", ffmpeg_failure(ffmpeg::NOT_IMPLEMENTED)),
        ("hevc_qsv", anyhow::anyhow!("Failed to create QSV device")),
    ];
    let message = no_hw_encoder_message(&failures, || panic!("driver must not be queried"));
    assert!(message.starts_with("no_hw_encoder: No hardware encoder is available;"));
    assert!(!message.contains("nvidia_driver_outdated"));
}

#[test]
fn nvenc_requirement_matches_the_loaded_avcodec_build() {
    // FFmpeg embeds the minimum driver of the NVENC SDK it was built with; an FFmpeg upgrade that raises it fails here.
    let dir = std::env::var_os("ADITORREC_FFMPEG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../build/ffmpeg")));
    let path = dir
        .join("bin")
        .join(format!("avcodec-{}.dll", ffi::LIBAVCODEC_VERSION_MAJOR));
    let dll = fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "Cannot read {}; set ADITORREC_FFMPEG_DIR to the FFmpeg root containing bin: {error}",
            path.display()
        )
    });
    let contains = |needle: &[u8]| dll.windows(needle.len()).any(|window| window == needle);
    assert!(contains(
        b"The minimum required Nvidia driver for nvenc is %s or newer"
    ));
    assert!(
        contains(format!("\0{}\0", nvenc::MIN_DRIVER).as_bytes()),
        "avcodec no longer requires driver {}; update nvenc::REQUIRED_API and MIN_DRIVER",
        nvenc::MIN_DRIVER
    );
}

#[test]
fn nvidia_driver_api_query_reports_a_plausible_version_when_present() {
    // Runs on any machine; only machines with an NVIDIA driver exercise the FFI call result.
    if let Some((major, minor)) = nvenc::driver_api() {
        assert!((5..=99).contains(&major) && minor < 16, "{major}.{minor}");
    }
}

#[test]
fn worker_failures_are_latched_without_further_frames() {
    let counts = Counts::default();
    monitor_worker(&counts, || Ok(())).unwrap();
    assert!(counts.check_error().is_ok());
    assert!(monitor_worker(&counts, || bail!("Test mux failure")).is_err());
    counts.fail("subsequent error");
    assert_eq!(counts.error.get().unwrap(), "Test mux failure");
    assert!(counts
        .check_error()
        .unwrap_err()
        .to_string()
        .contains("Test mux failure"));
}

#[test]
fn worker_panics_are_latched_as_encode_errors() {
    let counts = Counts::default();
    assert!(monitor_worker(&counts, || panic!("test encoder panic")).is_err());
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
        "aditorrec-encode-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_DIR.fetch_add(1, Ordering::Relaxed)
    ))
}
fn executable(name: &str) -> std::path::PathBuf {
    std::env::var_os("ADITORREC_FFMPEG_DIR")
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
    // SAFETY: Valid device, single-mip BGRA description, and output reference managed by the windows crate.
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
fn encoder_names_preserve_vendor_order_and_hevc_fallback_for_every_codec() {
    for (codec, expected) in [
        (
            Codec::Hevc,
            [
                "hevc_nvenc",
                "hevc_amf",
                "hevc_qsv",
                "h264_nvenc",
                "h264_amf",
                "h264_qsv",
            ]
            .as_slice(),
        ),
        (
            Codec::H264,
            ["h264_nvenc", "h264_amf", "h264_qsv"].as_slice(),
        ),
        (Codec::Av1, ["av1_nvenc", "av1_amf", "av1_qsv"].as_slice()),
    ] {
        assert_eq!(candidate_names(codec, "auto"), expected, "{codec:?}");
        assert_eq!(candidates(&params(codec)), expected, "{codec:?}");
    }
}

#[test]
fn explicit_encoder_names_are_kept_only_when_their_codec_matches() {
    for (codec, name) in [
        (Codec::Hevc, "hevc_amf"),
        (Codec::H264, "h264_qsv"),
        (Codec::Av1, "av1_nvenc"),
    ] {
        assert_eq!(candidate_names(codec, name), [name], "{codec:?}");
    }
    for (codec, name) in [
        (Codec::Hevc, "h264_nvenc"),
        (Codec::H264, "hevc_nvenc"),
        (Codec::Av1, "h264_amf"),
    ] {
        assert!(candidate_names(codec, name).is_empty(), "{codec:?}");
    }
    for codec in [Codec::Hevc, Codec::H264, Codec::Av1] {
        assert!(candidate_names(codec, "libx264").is_empty(), "{codec:?}");
        assert!(candidate_names(codec, "").is_empty(), "{codec:?}");
    }
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
    packets.extend(audio.push(&vec![0.1; 960], 100_000).unwrap()); // Duplicate chunks should be discarded.
    packets.extend(audio.push(&vec![0.2; 960], 300_000).unwrap()); // 10 ms of silence in the gap.
    packets.extend(audio.finish(400_000).unwrap());
    let times: Vec<_> = packets
        .iter()
        .map(|p| {
            // SAFETY: The test owns a valid packet and only reads its timestamp.
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
            // SAFETY: The RTV and source texture use the same device; the D3D11 context has multithread protection enabled.
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
        assert!(
            delivered_live,
            "A complete segment must be delivered before finish"
        );
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
        assert!(
            (duration - expected).abs() < 0.05,
            "Actual segment duration={duration}"
        );
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
        assert!(
            (frequency - 440.).abs() < 3.,
            "AAC decoded frequency={frequency}"
        );
        let rms = (interval.iter().map(|s| s * s).sum::<f32>() / interval.len() as f32).sqrt();
        assert!(
            (rms - 0.2 / 2f32.sqrt()).abs() < 0.02,
            "AAC decoded amplitude={rms}"
        );
    }
    let duration = json["format"]["duration"]
        .as_str()
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!(
        (duration - frame_count as f64 / 60.).abs() < 0.2,
        "Total duration={duration}"
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
    // Decode the color blocks at the beginning and end to verify GPU copying/scaling did not produce black frames or use an overwritten surface.
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
        "First frame must be red: {:?}",
        pixels.stdout
    );
    for (&actual, expected) in pixels.stdout[..3].iter().zip([204u8, 0, 26]) {
        assert!(
            actual.abs_diff(expected) <= 8,
            "First-frame color should be preserved: {:?}",
            pixels.stdout
        );
    }
    if frame_count > 120 {
        assert!(
            pixels.stdout[5] > pixels.stdout[3] + 80,
            "Second segment must be blue: {:?}",
            pixels.stdout
        );
    }
    eprintln!(
        "{name}: source {source_size:?}, {} segments, {duration:.3} seconds, decode succeeded",
        segments.len()
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn gpu_recording_and_scaling_have_independent_keyframe_segments() {
    let _guard = GPU_TEST.lock().unwrap();
    let gpu = Gpu::create().unwrap();
    let names = SegmentWriter::probe_encoders(&gpu);
    eprintln!("Available encoders from the actual probe: {names:?}");
    assert!(
        names.iter().any(|name| name == "hevc_nvenc"),
        "Local RTX 5080 should support HEVC NVENC"
    );
    record(&gpu, (1280, 720), "hevc_nvenc", true, 300, false);
    record(&gpu, (1920, 1080), "hevc_nvenc", true, 300, true);
    for name in ["h264_nvenc", "av1_nvenc"] {
        assert!(names.iter().any(|available| available == name));
        record(&gpu, (1280, 720), name, name == "av1_nvenc", 300, false);
    }
}

/// A BGRA texture with only the shader-resource binding, which cannot back a video-processor input view.
fn shader_only_texture(gpu: &Gpu, size: (u32, u32)) -> ID3D11Texture2D {
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
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        ..Default::default()
    };
    let mut texture = None;
    // SAFETY: Valid device and single-mip BGRA description; output reference managed by the windows crate.
    unsafe {
        gpu.device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .unwrap();
    }
    texture.unwrap()
}

/// `scale` is the source-to-target ratio; `shader_only` exercises the input-view copy fallback.
fn check_nv12_range_and_edges(gpu: &Gpu, size: (u32, u32), scale: u32, shader_only: bool) {
    let video = VideoParams {
        width: size.0,
        height: size.1,
        ..params(Codec::Hevc)
    };
    let hardware = Hardware::new(gpu, &video, ffi::AV_PIX_FMT_NV12).unwrap();
    let frame = hardware.surface().unwrap();
    let source_size = (size.0 * scale, size.1 * scale);
    let source = if shader_only {
        shader_only_texture(gpu, source_size)
    } else {
        texture(gpu, source_size).0
    };
    let colors = [
        [0, 0, 0, 255],
        [255, 255, 255, 255],
        [0, 0, 255, 255],
        [255, 0, 0, 255],
    ];
    let row: Vec<u8> = (0..source_size.0)
        .flat_map(|x| colors[(x * 4 / source_size.0) as usize])
        .collect();
    let pixels = row.repeat(source_size.1 as usize);
    let mut staging = None;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: The frame owns a live D3D11 texture; from_raw_borrowed retains frame ownership.
    let target = unsafe {
        ID3D11Texture2D::from_raw_borrowed(&(*frame.0).data[0].cast())
            .unwrap()
            .clone()
    };
    // SAFETY: The source upload covers all rows; the staging texture matches the target and is CPU-readable.
    unsafe {
        gpu.context.UpdateSubresource(
            &source,
            0,
            None,
            pixels.as_ptr().cast(),
            source_size.0 * 4,
            0,
        );
        target.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        gpu.device
            .CreateTexture2D(&desc, None, Some(&mut staging))
            .unwrap();
    }
    Copier::new(gpu, &video, hardware.format)
        .copy(&source, source_size, &frame)
        .unwrap();
    let staging = staging.unwrap();
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    // SAFETY: Test-only blocking readback follows the conversion; all plane offsets respect RowPitch.
    unsafe {
        gpu.context.CopyResource(&staging, &target);
        gpu.context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .unwrap();
        let pitch = mapped.RowPitch as usize;
        let data =
            std::slice::from_raw_parts(mapped.pData.cast::<u8>(), pitch * size.1 as usize * 3 / 2);
        for (stripe, expected) in [
            [16u8, 128, 128],
            [235, 128, 128],
            [63, 102, 240],
            [32, 240, 118],
        ]
        .iter()
        .enumerate()
        {
            let left = stripe * size.0 as usize / 4;
            let right = (stripe + 1) * size.0 as usize / 4;
            for x in [
                if stripe == 0 { left } else { left + 2 },
                if stripe == 3 { right - 2 } else { right - 4 },
            ] {
                for y in [0, size.1 as usize / 2, size.1 as usize - 1] {
                    let uv = pitch * size.1 as usize + y / 2 * pitch + (x & !1);
                    let actual = [data[y * pitch + x], data[uv], data[uv + 1]];
                    for (actual, expected) in actual.into_iter().zip(*expected) {
                        assert!(
                            actual.abs_diff(expected) <= 3,
                            "{size:?} at ({x}, {y}): {actual} != {expected}"
                        );
                    }
                }
            }
        }
        gpu.context.Unmap(&staging, 0);
    }
}

#[test]
fn gpu_nv12_conversion_and_error_propagation() {
    let _guard = GPU_TEST.lock().unwrap();
    let gpu = Gpu::create().unwrap();
    for name in ENCODERS {
        let expected = if name.ends_with("_nvenc") {
            [ffi::AV_PIX_FMT_NV12, ffi::AV_PIX_FMT_BGRA]
        } else {
            [ffi::AV_PIX_FMT_BGRA, ffi::AV_PIX_FMT_NV12]
        };
        assert_eq!(input_formats(name), expected);
    }
    assert_eq!(probe(&gpu, "hevc_nvenc").unwrap(), ffi::AV_PIX_FMT_NV12);
    for size in [(256, 144), (1920, 1080)] {
        check_nv12_range_and_edges(&gpu, size, 2, false);
    }
    // Native-size NV12 always goes through the video processor, including sources it cannot view directly.
    for shader_only in [false, true] {
        check_nv12_range_and_edges(&gpu, (256, 144), 1, shader_only);
    }
    let video = VideoParams {
        width: 1920,
        height: 1080,
        ..params(Codec::Hevc)
    };
    let hardware = Hardware::new(&gpu, &video, ffi::AV_PIX_FMT_NV12).unwrap();
    let encoder = hardware.encoder("hevc_nvenc", &video).unwrap();
    let frame = hardware.surface().unwrap();
    let (source, view) = texture(&gpu, (1920, 1080));
    // SAFETY: A valid RTV on the same device.
    unsafe {
        gpu.context
            .ClearRenderTargetView(&view, &[0.8, 0.1, 0.1, 1.]);
    }
    Copier::new(&gpu, &video, hardware.format)
        .copy(&source, (1920, 1080), &frame)
        .unwrap();
    // SAFETY: This test exclusively owns the frame metadata.
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
    // SAFETY: The test exclusively owns the packet and assigns an explicit duration to this single-frame recording.
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
    let metadata = Command::new(executable("ffprobe"))
        .args(["-v", "error", "-show_streams", "-of", "json"])
        .arg(&combined)
        .output()
        .unwrap();
    assert!(
        metadata.status.success(),
        "{}",
        String::from_utf8_lossy(&metadata.stderr)
    );
    let metadata: serde_json::Value = serde_json::from_slice(&metadata.stdout).unwrap();
    let stream = &metadata["streams"][0];
    assert_eq!(stream["width"], 1920);
    assert_eq!(stream["height"], 1080);
    assert_eq!(stream["color_range"], "tv");
    for key in ["color_space", "color_primaries", "color_transfer"] {
        assert_eq!(stream[key], "bt709", "{key}");
    }
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
        "NV12 conversion color mismatch: {:?}",
        pixels.stdout
    );
    for (&actual, expected) in pixels.stdout.iter().zip([204u8, 26, 26]) {
        assert!(
            actual.abs_diff(expected) <= 8,
            "NV12 colors should be preserved: {:?}",
            pixels.stdout
        );
    }
    fs::remove_dir_all(dir).unwrap();

    // Simulate a stalled encoder thread and verify calls still return immediately when all 8 slots are full.
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
    // SAFETY: The locked producer retains the D3D11 frame and its hardware frame context.
    unsafe {
        let frames = (*lock.pool[0].frame.0).hw_frames_ctx;
        let context = &*((*frames).data as *const ffi::AVHWFramesContext);
        assert_eq!(context.sw_format, ffi::AV_PIX_FMT_NV12);
    }
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
        "CFR frame duplication must stop after a copy failure"
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
    // SAFETY: A valid same-device RTV; only used to set known color blocks in this test.
    unsafe {
        gpu.context
            .ClearRenderTargetView(&view, &[0.8, 0.1, 0.1, 1.]);
    }
    assert_eq!(writer.push_video(&source, 1280, 720, 0), PushResult::Queued);
    // Simulate WGC stopping frame delivery for a static image while WASAPI has no audio chunks.
    // Allow the static-frame holdback, mixer deadline and AAC delay before a segment is ready.
    thread::sleep(Duration::from_millis(2800));
    assert_eq!(writer.stats().frames_in, 1);
    assert!(writer.stats().frames_encoded >= 120);
    let mut segments: Vec<_> = rx.try_iter().collect();
    assert!(
        !segments.is_empty(),
        "Segments should still finish while recording a static image"
    );
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
    assert!(
        (duration - 2.8).abs() < 0.1,
        "Static-image recording duration={duration}"
    );
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
