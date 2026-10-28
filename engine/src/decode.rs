use crate::process::Child;
use crate::{
    cv::{self, Image},
    ffbin,
    profile::Profile,
};
use std::{
    collections::VecDeque,
    fmt,
    io::{ErrorKind, Read},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
};
pub const FPS: usize = 4;
pub const STDERR_LIMIT: usize = 64 * 1024;
#[cfg(test)]
mod tests;
#[derive(Debug)]
pub struct DecodeError {
    pub message: String,
    pub stderr_tail: String,
}
impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for DecodeError {}
pub fn is_gpu_path(codec: Option<&str>, hwaccel: bool) -> bool {
    hwaccel && codec.is_some_and(|c| ["av1", "h264", "hevc", "vp9"].contains(&c))
}
pub fn build_input_args(codec: Option<&str>, hwaccel: bool, start: f64) -> Vec<String> {
    let mut args: Vec<String> = [
        "-threads",
        "2",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
    ]
    .map(str::to_owned)
    .into();
    if is_gpu_path(codec, hwaccel) {
        args.extend(["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"].map(str::to_owned));
        if codec == Some("av1") {
            args.extend(["-c:v", "av1"].map(str::to_owned));
        }
    } else if hwaccel {
        args.extend(["-hwaccel", "auto"].map(str::to_owned));
    }
    if start > 0. {
        args.extend(["-ss".into(), format!("{start:.3}")]);
    }
    args
}
pub fn build_filter(profile: &Profile, gpu: bool, hw_format: &str) -> String {
    build_filter_rects(profile, gpu, hw_format, None)
}
fn build_filter_rects(
    profile: &Profile,
    gpu: bool,
    hw_format: &str,
    capture: Option<(crate::layout::Rect, crate::layout::Rect)>,
) -> String {
    let (banner, spec) =
        capture.unwrap_or_else(|| (profile.capture_banner(), profile.capture_spec()));
    let [bx, by, bw, bh] = banner;
    let [sx, sy, sw, sh] = spec;
    let planar = if hw_format == "p010le" {
        "yuv420p10le"
    } else {
        "yuv420p"
    };
    let pre = if gpu {
        format!("fps={FPS},hwdownload,format={hw_format},format={planar}")
    } else {
        format!("fps={FPS}")
    };
    if let Some([fx, fy, fw, fh]) = profile.capture_killfeed() {
        let width = bw.max(sw).max(fw);
        return format!("[0:v]{pre},scale=1920:1080,split=4[a][b][c][d];[a]crop={bw}:{bh}:{bx}:{by},pad={width}:ih[a1];[b]crop={sw}:{sh}:{sx}:{sy},pad={width}:ih[b1];[c]crop={fw}:{fh}:{fx}:{fy},pad={width}:ih[c1];[d]scale=640:360,pad={width}:360[d1];[a1][b1][c1][d1]vstack=inputs=4");
    }
    format!("[0:v]{pre},scale=1920:1080,split[a][b];[a]crop={bw}:{bh}:{bx}:{by}[a1];[b]crop={sw}:{sh}:{sx}:{sy},pad={bw}:ih[b1];[a1][b1]vstack")
}
#[derive(Clone, Debug)]
pub struct DecodeOptions {
    pub start: f64,
    pub end: Option<f64>,
    pub hwaccel: bool,
    pub codec: Option<String>,
}
impl Default for DecodeOptions {
    fn default() -> Self {
        Self {
            start: 0.,
            end: None,
            hwaccel: true,
            codec: None,
        }
    }
}
pub type Frame = (f64, Image<u8>, Image<u8>);
pub struct FrameStream {
    path: String,
    profile: Profile,
    options: DecodeOptions,
    pub used_hwaccel: bool,
    pub killfeed: Option<Image<u8>>,
    pub thumb: Option<Image<u8>>,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    reader: Option<JoinHandle<()>>,
    proc: Option<Child>,
    plans: VecDeque<(bool, &'static str)>,
    k: usize,
    attempt_start: usize,
    closed: bool,
    capture: Option<(crate::layout::Rect, crate::layout::Rect)>,
}
impl FrameStream {
    pub fn new(path: impl Into<String>, profile: Profile, options: DecodeOptions) -> Self {
        let mut plans = VecDeque::new();
        if options.hwaccel {
            plans.push_back((true, "nv12"));
            if is_gpu_path(options.codec.as_deref(), true) {
                plans.push_back((true, "p010le"));
            }
        }
        plans.push_back((false, "nv12"));
        Self {
            path: path.into(),
            profile,
            used_hwaccel: options.hwaccel,
            options,
            killfeed: None,
            thumb: None,
            stderr: Arc::new(Mutex::new(VecDeque::new())),
            reader: None,
            proc: None,
            plans,
            k: 0,
            attempt_start: 0,
            closed: false,
            capture: None,
        }
    }
    pub fn for_capture(
        path: &str,
        profile: Profile,
        options: DecodeOptions,
        banner: crate::layout::Rect,
        spec: crate::layout::Rect,
    ) -> Self {
        let mut stream = Self::new(path, profile, options);
        stream.capture = Some((banner, spec));
        stream
    }
    fn rects(&self) -> (crate::layout::Rect, crate::layout::Rect) {
        self.capture
            .unwrap_or_else(|| (self.profile.capture_banner(), self.profile.capture_spec()))
    }
    pub fn stderr_tail(&self) -> String {
        String::from_utf8_lossy(
            &self
                .stderr
                .lock()
                .unwrap()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
        )
        .into_owned()
    }
    fn error(&self, message: impl Into<String>) -> DecodeError {
        DecodeError {
            message: message.into(),
            stderr_tail: self.stderr_tail(),
        }
    }
    fn reap(&mut self, kill: bool) {
        if let Some(mut proc) = self.proc.take() {
            if kill {
                let _ = proc.kill();
            }
            let _ = proc.wait();
            drop(proc);
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
    fn spawn(&mut self, hw: bool, format: &str) -> Result<(), DecodeError> {
        self.stderr.lock().unwrap().clear();
        self.used_hwaccel = hw;
        self.attempt_start = self.k;
        let start = self.options.start + self.k as f64 / FPS as f64;
        let exe = ffbin::ffmpeg().map_err(|e| self.error(e.to_string()))?;
        let mut cmd = Command::new(exe);
        cmd.args(["-v", "error", "-nostdin"])
            .args(build_input_args(self.options.codec.as_deref(), hw, start))
            .args([
                "-i",
                &self.path,
                "-filter_complex",
                &build_filter_rects(
                    &self.profile,
                    is_gpu_path(self.options.codec.as_deref(), hw),
                    format,
                    self.capture,
                ),
            ]);
        if let Some(end) = self.options.end {
            cmd.args(["-t", &format!("{:.3}", (end - start).max(0.))]);
        }
        let mut proc = crate::process::spawn(
            cmd.args([
                "-pix_fmt", "bgr24", "-threads", "1", "-f", "rawvideo", "pipe:1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
        )
        .map_err(|e| self.error(e.to_string()))?;
        let mut pipe = proc.stderr.take().unwrap();
        let tail = Arc::clone(&self.stderr);
        self.reader = Some(thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut tail = tail.lock().unwrap();
                        tail.extend(&buf[..n]);
                        let excess = tail.len().saturating_sub(STDERR_LIMIT);
                        tail.drain(..excess);
                    }
                }
            }
        }));
        self.proc = Some(proc);
        Ok(())
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.reap(true);
    }
    fn frame(&mut self, arr: Image<u8>) -> anyhow::Result<Frame> {
        let ([_, _, bw, bh], [_, _, sw, sh]) = self.rects();
        let banner = arr.crop(0, 0, bw as usize, bh as usize)?;
        let spec = arr.crop(0, bh as usize, sw as usize, sh as usize)?;
        let (banner, spec) = if self.capture.is_none() {
            self.profile.restore(&banner, &spec)?
        } else {
            (banner, spec)
        };
        if let Some([_, _, fw, fh]) = self.profile.capture_killfeed() {
            self.killfeed = Some(self.profile.restore_killfeed(&arr.crop(
                0,
                (bh + sh) as usize,
                fw as usize,
                fh as usize,
            )?)?);
            self.thumb = Some(cv::gray(&arr.crop(0, arr.height - 360, 640, 360)?)?);
        }
        let t = self.options.start + self.k as f64 / FPS as f64;
        self.k += 1;
        Ok((t, banner, spec))
    }
}
impl Iterator for FrameStream {
    type Item = Result<Frame, DecodeError>;
    fn next(&mut self) -> Option<Self::Item> {
        self.next_cancellable(&|| false)
    }
}
impl FrameStream {
    pub fn next_cancellable(
        &mut self,
        stopped: &(dyn Fn() -> bool + Sync),
    ) -> Option<Result<Frame, DecodeError>> {
        if self.closed {
            return None;
        }
        loop {
            if self.proc.is_none() {
                let plan = loop {
                    match self.plans.pop_front() {
                        Some((_, "p010le")) if self.k > 0 => continue,
                        other => break other,
                    }
                };
                let Some((hw, format)) = plan else {
                    let e = self.error("ffmpeg decoding failed");
                    self.close();
                    return Some(Err(e));
                };
                if let Err(e) = self.spawn(hw, format) {
                    self.close();
                    return Some(Err(e));
                }
            }
            let ([_, _, bw, bh], [_, _, sw, sh]) = self.rects();
            let (width, height) = if let Some([_, _, fw, fh]) = self.profile.capture_killfeed() {
                (bw.max(sw).max(fw) as usize, (bh + sh + fh + 360) as usize)
            } else {
                (bw as usize, (bh + sh) as usize)
            };
            let mut buf = vec![0u8; width * height * 3];
            let read = crate::process::read_exact(
                self.proc.as_mut().unwrap().stdout.as_mut().unwrap(),
                &mut buf,
                stopped,
            );
            match read {
                Ok(()) => match self.frame(Image {
                    width,
                    height,
                    channels: 3,
                    data: buf,
                }) {
                    Ok(frame) => return Some(Ok(frame)),
                    Err(e) => {
                        let e = self.error(e.to_string());
                        self.close();
                        return Some(Err(e));
                    }
                },
                Err(e) if e.kind() != ErrorKind::UnexpectedEof => {
                    let e = self.error(e.to_string());
                    self.close();
                    return Some(Err(e));
                }
                Err(_) => {}
            }
            let status = loop {
                if stopped() {
                    let error = self.error("Decoding cancelled");
                    self.close();
                    return Some(Err(error));
                }
                match self.proc.as_mut().unwrap().try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => thread::sleep(std::time::Duration::from_millis(10)),
                    Err(e) => break Err(e),
                }
            };
            self.reap(false);
            match status {
                Ok(s) if s.success() => {
                    self.close();
                    return None;
                }
                Ok(s) if !self.used_hwaccel && self.k > self.attempt_start => {
                    let e = self.error(format!(
                        "ffmpeg exited unexpectedly ({})",
                        s.code().unwrap_or(-1)
                    ));
                    self.close();
                    return Some(Err(e));
                }
                Err(e) => {
                    let e = self.error(e.to_string());
                    self.close();
                    return Some(Err(e));
                }
                _ => {}
            }
        }
    }
}
impl Drop for FrameStream {
    fn drop(&mut self) {
        self.close();
    }
}
pub fn iter_frames(
    path: impl Into<String>,
    profile: Profile,
    options: DecodeOptions,
) -> FrameStream {
    FrameStream::new(path, profile, options)
}
