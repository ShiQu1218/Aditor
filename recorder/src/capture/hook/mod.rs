//! OBS graphics-hook game capture: setup (window lookup, injection, readiness, adapter selection) and the paced capture loop.

pub mod adapter;
pub mod convert;
pub mod protocol;
pub mod session;

use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

use self::convert::Converter;
use self::session::{HookFiles, HookSession, SharedTexture};
use super::{
    find_window, window_matches, CaptureNotice, CaptureOptions, CapturedFrame, FrameConsumer,
};
use crate::clock;
use crate::gpu::Gpu;

/// Total time budget for hook initialization, including window lookup, injection, loading, and initial HookReady.
pub const PREPARE_BUDGET: Duration = Duration::from_secs(15);

/// Window liveness-check interval.
const WINDOW_CHECK: Duration = Duration::from_secs(1);

/// Connected to the hook and received the first shared texture; passed to Capture::start_hook.
/// Fields follow drop order: release the shared texture first and send Stop from HookSession last if setup fails.
pub struct Prepared {
    texture: ID3D11Texture2D,
    info: SharedTexture,
    probe: HwndProbe,
    session: HookSession,
}

const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<Prepared>();
};

/// Completes window lookup, hook-file validation, attachment, readiness wait, and shared-texture opening within the budget.
/// → wait_ready (remaining time) → adapter::open_shared(handle).
/// Returns the prepared capture and the GPU for the game adapter, used for the entire recording job.
pub fn prepare(pid: u32, hook_dir: &Path, fps: u32, budget: Duration) -> Result<(Prepared, Gpu)> {
    let deadline = Instant::now() + budget;
    let hwnd = find_window(pid)?;
    let files = HookFiles::new(hook_dir)?;
    let mut session = HookSession::attach(
        pid,
        hwnd,
        &files,
        fps,
        deadline.saturating_duration_since(Instant::now()),
    )?;
    let Some(info) = session.wait_ready(deadline.saturating_duration_since(Instant::now()))? else {
        bail!("hook_unavailable: Timed out waiting for readiness (the game may not be rendering or may use an unsupported graphics API)");
    };
    let (gpu, texture) = adapter::open_shared(info.handle)?;
    Ok((
        Prepared {
            texture,
            info,
            probe: HwndProbe { hwnd, pid },
            session,
        },
        gpu,
    ))
}

trait TextureSource: Send {
    fn poll(&mut self) -> Result<Option<SharedTexture>>;
}

impl TextureSource for HookSession {
    fn poll(&mut self) -> Result<Option<SharedTexture>> {
        self.wait_ready(Duration::ZERO)
    }
}

trait WindowProbe: Send {
    fn alive(&self) -> bool;
}

struct HwndProbe {
    hwnd: HWND,
    pid: u32,
}

// SAFETY: HWND is a system-level handle used only for thread-safe window-state queries.
unsafe impl Send for HwndProbe {}

impl WindowProbe for HwndProbe {
    fn alive(&self) -> bool {
        window_matches(self.hwnd, self.pid)
    }
}

/// Computes the next scheduled frame time; when behind, skips whole periods without filling frames,
/// keeping scheduled times aligned to the same frame grid.
fn next_frame_time(last: Instant, now: Instant, period: Duration) -> Instant {
    let next = last + period;
    if now <= next {
        return next;
    }
    let periods = (now - last).as_nanos() / period.as_nanos().max(1);
    last + Duration::from_nanos((period.as_nanos() * periods) as u64)
}

/// Converts scheduled time (not wake time) to PTS. The encoder uses rounded PTS times FPS to determine frame indices,
/// so wake-time jitter can collide with a frame index; grid times assign exactly one index per frame.
fn grid_pts(start_ticks: i64, start: Instant, scheduled: Instant) -> i64 {
    start_ticks + (scheduled.saturating_duration_since(start).as_nanos() / 100) as i64
}

pub(super) fn run(
    prepared: Prepared,
    gpu: Gpu,
    opts: CaptureOptions,
    consumer: Box<dyn FrameConsumer>,
    notices: Sender<CaptureNotice>,
    stopped: Receiver<()>,
    ready: &mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    let Prepared {
        texture,
        info,
        probe,
        session,
    } = prepared;
    run_loop(
        gpu,
        opts,
        texture,
        info.format,
        session,
        probe,
        consumer,
        notices,
        stopped,
        ready,
    )
}

/// The game continues presenting while in the background or minimized (observed with Apex), so this path does not check visibility or send black frames;
/// If the game stops presenting, the texture remains on the last frame.
#[allow(clippy::too_many_arguments)]
fn run_loop<S: TextureSource, W: WindowProbe>(
    gpu: Gpu,
    opts: CaptureOptions,
    initial_texture: ID3D11Texture2D,
    initial_format: u32,
    source: S,
    window: W,
    mut consumer: Box<dyn FrameConsumer>,
    notices: Sender<CaptureNotice>,
    stopped: Receiver<()>,
    ready: &mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    // Bind source first so Converter and textures are released before HookSession on both normal return and errors,
    // which sends CaptureHook_Stop when released.
    let mut source = source;
    let mut shared_texture = initial_texture;
    let mut converter = Converter::new(&gpu, &shared_texture, initial_format)?;
    let mut size = converter.size();

    let _ = notices.send(CaptureNotice::WindowFound {
        width: size.0,
        height: size.1,
        monitor: false,
    });
    let _ = ready.send(Ok(()));

    let period = Duration::from_nanos(1_000_000_000 / u64::from(opts.max_fps.max(1)));
    let start = Instant::now();
    let start_ticks = clock::now_ticks() - opts.origin_ticks;
    let mut scheduled = start;
    let mut next_window_check = scheduled + WINDOW_CHECK;

    loop {
        let now = Instant::now();
        scheduled = next_frame_time(scheduled, now, period);
        match stopped.recv_timeout(scheduled.saturating_duration_since(now)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if let Some(tex) = source.poll()? {
            let new_texture = adapter::open_shared_on(&gpu, tex.handle)?;
            let new_converter = Converter::new(&gpu, &new_texture, tex.format)?;
            let new_size = new_converter.size();
            converter = new_converter;
            shared_texture = new_texture;
            if new_size != size {
                size = new_size;
                let _ = notices.send(CaptureNotice::WindowFound {
                    width: size.0,
                    height: size.1,
                    monitor: false,
                });
            }
        }

        if Instant::now() >= next_window_check {
            next_window_check = Instant::now() + WINDOW_CHECK;
            if !window.alive() {
                let _ = notices.send(CaptureNotice::WindowLost);
                bail!("hook_unavailable: Game capture window disappeared; restart capture on the current game window");
            }
        }

        let pts = grid_pts(start_ticks, start, scheduled);
        let texture = converter.run(&gpu);
        consumer.on_frame(&CapturedFrame {
            texture,
            width: size.0,
            height: size.1,
            pts,
        });
    }

    // Explicit drop order: converter and shared texture first, then HookSession.
    drop(converter);
    drop(shared_texture);
    drop(consumer);
    drop(source);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE,
        D3D11_MAP_READ, D3D11_RESOURCE_MISC_SHARED, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC,
    };
    use windows::Win32::Graphics::Dxgi::IDXGIResource;

    use super::*;

    #[test]
    fn frame_schedule_advances_by_period_and_realigns_when_behind() {
        let base = Instant::now();
        let period = Duration::from_millis(33);

        // Normal: the next scheduled frame is not due; keep last + period.
        assert_eq!(
            next_frame_time(base, base + Duration::from_millis(5), period),
            base + period
        );
        // Exactly on the boundary: keep last + period.
        assert_eq!(next_frame_time(base, base + period, period), base + period);
        // Behind: skip whole periods and stay on the grid without filling frames.
        let late = base + Duration::from_millis(45);
        assert_eq!(next_frame_time(base, late, period), base + period);
        let very_late = base + Duration::from_millis(200);
        assert_eq!(
            next_frame_time(base, very_late, period),
            base + Duration::from_millis(198)
        );
    }

    #[test]
    fn grid_pts_gives_every_frame_its_own_encoder_slot() {
        let fps = 60u32;
        let period = Duration::from_nanos(1_000_000_000 / u64::from(fps));
        let start = Instant::now();
        let start_ticks = 123_456_789;
        let mut scheduled = start;
        let mut previous = None;
        for _ in 0..600 {
            scheduled = next_frame_time(scheduled, scheduled, period);
            let pts = grid_pts(start_ticks, start, scheduled) - start_ticks;
            // Uses the same frame-index calculation as encode/mod.rs.
            let slot = (pts as i128 * fps as i128 + 5_000_000) / 10_000_000;
            if let Some(prev) = previous {
                assert_eq!(slot, prev + 1);
            }
            previous = Some(slot);
        }
    }

    struct FakeTextureSource {
        queue: Arc<Mutex<VecDeque<SharedTexture>>>,
    }

    impl TextureSource for FakeTextureSource {
        fn poll(&mut self) -> Result<Option<SharedTexture>> {
            Ok(self.queue.lock().unwrap().pop_front())
        }
    }

    #[derive(Clone)]
    struct FakeWindowProbe {
        alive: Arc<AtomicBool>,
    }

    impl WindowProbe for FakeWindowProbe {
        fn alive(&self) -> bool {
            self.alive.load(Ordering::Acquire)
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct FrameSample {
        pts: i64,
        width: u32,
        height: u32,
        top_left_bgra: [u8; 4],
    }

    struct RecordingConsumer {
        gpu: Gpu,
        samples: Arc<Mutex<Vec<FrameSample>>>,
    }

    impl FrameConsumer for RecordingConsumer {
        fn on_frame(&mut self, frame: &CapturedFrame<'_>) {
            let top_left_bgra = read_top_left_bgra(&self.gpu, frame.texture);
            self.samples.lock().unwrap().push(FrameSample {
                pts: frame.pts,
                width: frame.width,
                height: frame.height,
                top_left_bgra,
            });
        }
    }

    fn create_shared_rgba_texture(
        gpu: &Gpu,
        width: u32,
        height: u32,
        rgba: [u8; 4],
    ) -> (ID3D11Texture2D, SharedTexture) {
        let pixels = vec![rgba; (width * height) as usize];
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            MiscFlags: D3D11_RESOURCE_MISC_SHARED.0 as u32,
            ..Default::default()
        };
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        let mut tex = None;
        // SAFETY: pixels has width * height * 4 bytes; create a shared 2D test texture and Flush.
        unsafe {
            gpu.device
                .CreateTexture2D(&desc, Some(&init), Some(&mut tex))
                .unwrap();
            gpu.context.Flush();
        }
        let tex = tex.unwrap();
        let resource: IDXGIResource = tex.cast().unwrap();
        // SAFETY: Get the legacy shared-resource handle.
        let raw_handle = unsafe { resource.GetSharedHandle() }.unwrap();
        let handle = raw_handle.0 as usize as u32;
        (
            tex,
            SharedTexture {
                handle,
                width,
                height,
                format: DXGI_FORMAT_R8G8B8A8_UNORM.0 as u32,
            },
        )
    }

    fn read_top_left_bgra(gpu: &Gpu, texture: &ID3D11Texture2D) -> [u8; 4] {
        let mut src_desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: Read texture dimensions and copy to staging to read back the top-left pixel.
        unsafe {
            texture.GetDesc(&mut src_desc);
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Width: src_desc.Width,
                Height: src_desc.Height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..Default::default()
            };
            let mut staging = None;
            gpu.device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))
                .unwrap();
            let staging = staging.unwrap();
            gpu.context.CopyResource(&staging, texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            gpu.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .unwrap();
            let ptr = mapped.pData.cast::<u8>();
            let px = [*ptr, *ptr.add(1), *ptr.add(2), *ptr.add(3)];
            gpu.context.Unmap(&staging, 0);
            px
        }
    }

    #[test]
    fn capture_loop_reports_window_loss_instead_of_freezing_forever() {
        let gpu = Gpu::create().unwrap();
        let (texture, info) = create_shared_rgba_texture(&gpu, 64, 32, [0, 0, 0, 255]);
        let source = FakeTextureSource { queue: Arc::new(Mutex::new(VecDeque::new())) };
        let window = FakeWindowProbe { alive: Arc::new(AtomicBool::new(false)) };
        let consumer = Box::new(RecordingConsumer {
            gpu: gpu.clone(), samples: Arc::new(Mutex::new(Vec::new())),
        });
        let (notices, events) = mpsc::channel();
        let (_stop, stopped) = mpsc::channel();
        let (ready, _initialized) = mpsc::sync_channel(1);
        let error = run_loop(gpu, CaptureOptions {
            pid: std::process::id(), max_fps: 30, capture_cursor: false,
            origin_ticks: clock::now_ticks(),
            sdr_size: None,
        }, texture, info.format, source, window, consumer, notices, stopped, &ready).unwrap_err();
        assert!(error.to_string().contains("hook_unavailable:"));
        assert!(events.try_iter().any(|e| e == CaptureNotice::WindowLost));
    }

    #[test]
    fn capture_loop_delivers_frames_handles_resize_and_stops_promptly() {
        let creator = Gpu::create().unwrap();
        // R=255, G=20, B=40, A=255 should become BGRA [40, 20, 255, 255].
        let (_keep_tex1, shared1) =
            create_shared_rgba_texture(&creator, 64, 32, [255, 20, 40, 255]);
        let (gpu, initial_opened) = adapter::open_shared(shared1.handle).unwrap();

        let queue = Arc::new(Mutex::new(VecDeque::from([shared1])));
        let source = FakeTextureSource {
            queue: queue.clone(),
        };
        let alive = Arc::new(AtomicBool::new(true));
        let probe = FakeWindowProbe { alive };
        let samples = Arc::new(Mutex::new(Vec::new()));
        let consumer = Box::new(RecordingConsumer {
            gpu: gpu.clone(),
            samples: samples.clone(),
        });
        let (notice_tx, notice_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let opts = CaptureOptions {
            pid: std::process::id(),
            max_fps: 30,
            capture_cursor: false,
            origin_ticks: clock::now_ticks(),
            sdr_size: None,
        };
        let loop_gpu = gpu.clone();
        let worker = thread::spawn(move || {
            run_loop(
                loop_gpu,
                opts,
                initial_opened,
                shared1.format,
                source,
                probe,
                consumer,
                notice_tx,
                stop_rx,
                &ready_tx,
            )
        });

        ready_rx.recv().unwrap().unwrap();
        assert_eq!(
            notice_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            CaptureNotice::WindowFound {
                width: 64,
                height: 32,
                monitor: false,
            }
        );

        // 1. Run at 30 fps for about 400 ms and check frame count and strictly increasing PTS.
        thread::sleep(Duration::from_millis(400));
        {
            let recorded = samples.lock().unwrap();
            assert!(
                (8..=16).contains(&recorded.len()),
                "Expected 8..=16 frames at 30 fps over 400 ms, got {}",
                recorded.len()
            );
            assert!(recorded.windows(2).all(|w| w[1].pts > w[0].pts));
            for sample in recorded.iter() {
                assert_eq!((sample.width, sample.height), (64, 32));
                assert_eq!(sample.top_left_bgra, [40, 20, 255, 255]);
            }
        }

        // 2. TextureSource returns a new shared texture with different dimensions; expect WindowFound with the new size.
        let (_keep_tex2, shared2) =
            create_shared_rgba_texture(&creator, 128, 48, [10, 200, 60, 255]);
        queue.lock().unwrap().push_back(shared2);
        assert_eq!(
            notice_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            CaptureNotice::WindowFound {
                width: 128,
                height: 48,
                monitor: false,
            }
        );
        thread::sleep(Duration::from_millis(120));
        {
            let recorded = samples.lock().unwrap();
            let resized: Vec<_> = recorded
                .iter()
                .filter(|s| (s.width, s.height) == (128, 48))
                .collect();
            assert!(
                !resized.is_empty(),
                "A frame with the new size should arrive after resize"
            );
            for sample in resized {
                assert_eq!(sample.top_left_bgra, [60, 200, 10, 255]);
            }
            assert!(recorded.windows(2).all(|w| w[1].pts > w[0].pts));
        }

        // 3. Stop and verify the worker exits within 200 ms.
        let stop_at = Instant::now();
        stop_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        let elapsed = stop_at.elapsed();
        assert!(
            elapsed < Duration::from_millis(200),
            "Shutdown took too long: {elapsed:?}"
        );
    }
}
