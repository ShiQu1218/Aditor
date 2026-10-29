use crate::process::Child;
use crate::{
    aspect,
    cv::Image,
    decode::{self, DecodeError},
    ffbin,
    layout::Layout,
    probe,
    scene::{SceneFrame, SceneMatcher},
};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{ErrorKind, Read},
    path::Path,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Match {
    pub start: f64,
    pub end: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MatchEvent {
    pub r#type: String,
    pub t: f64,
    pub reason: String,
}
pub struct MatchTracker {
    max_gap: f64,
    first: Option<f64>,
    last: Option<f64>,
    active: Option<f64>,
    pending: Option<f64>,
    pre_last: Option<f64>,
    hud_first: Option<f64>,
    lobby_first: Option<f64>,
    blank_first: Option<f64>,
    end_pending: Option<f64>,
    end_pending_left: bool,
    recover_initial: bool,
    backdate_openings: bool,
    opening_hint: Option<f64>,
    finished: bool,
    pub matches: Vec<Match>,
    pub events: Vec<MatchEvent>,
}
impl MatchTracker {
    pub fn new(sample_period: f64) -> Result<Self> {
        if !sample_period.is_finite() || sample_period <= 0. {
            bail!("Sampling interval must be a finite positive number");
        }
        Ok(Self {
            max_gap: 2.5 * sample_period,
            first: None,
            last: None,
            active: None,
            pending: None,
            pre_last: None,
            hud_first: None,
            lobby_first: None,
            blank_first: None,
            end_pending: None,
            end_pending_left: false,
            recover_initial: true,
            backdate_openings: false,
            opening_hint: None,
            finished: false,
            matches: vec![],
            events: vec![],
        })
    }
    /// Offline only: a match recovered from the HUD starts at an opening screen seen shortly before it.
    /// Live keeps the plain HUD start because footage before a match is pruned after a few seconds.
    pub fn backdate_openings(mut self) -> Self {
        self.backdate_openings = true;
        self
    }
    fn event(&mut self, kind: &str, t: f64, reason: &str) {
        self.events.push(MatchEvent {
            r#type: kind.into(),
            t,
            reason: reason.into(),
        });
    }
    fn start(&mut self, t: f64, reason: &str) {
        self.active = Some(t);
        self.hud_first = None;
        self.opening_hint = None;
        self.event("match_start", t, reason);
    }
    fn end(&mut self, t: f64, reason: &str) {
        if let Some(start) = self.active.take() {
            if t > start {
                self.matches.push(Match { start, end: t });
                self.event("match_end", t, reason);
            }
        }
    }
    fn settle(&mut self) {
        if let Some(t) = self.end_pending.take() {
            self.end(t, "lobby");
            self.end_pending_left = false;
        }
    }
    pub fn feed(&mut self, t: f64, scene: &SceneFrame) -> Result<Vec<MatchEvent>> {
        if self.finished {
            bail!("Match stream has ended");
        }
        if !t.is_finite() || t < 0. || self.last.is_some_and(|v| t <= v) {
            bail!("Frame timestamps must be finite, non-negative, and strictly increasing");
        }
        let n = self.events.len();
        let first = *self.first.get_or_insert(t);
        if t - first > 10. {
            self.recover_initial = false;
        }
        let gap = self.last.is_some_and(|v| t - v > self.max_gap);
        self.last = Some(t);
        if gap || scene.kind != "lobby" {
            self.lobby_first = None;
        }
        if gap || scene.kind != "in_match_hud" {
            self.hud_first = None;
        }
        if gap || !scene.blank {
            self.blank_first = None;
        }
        if gap || self.opening_hint.is_some_and(|v| t - v > 180.) {
            self.opening_hint = None;
        }
        if self.backdate_openings
            && self.active.is_none()
            && self.pending.is_none()
            && scene.opening_hint()
        {
            self.opening_hint.get_or_insert(t);
        }
        if self.pending.is_some_and(|v| t - v > 180.) {
            self.event("match_cancel", t, "timeout");
            self.pending = None;
        }
        if scene.blank {
            let start = *self.blank_first.get_or_insert(t);
            if t - start >= 60. {
                self.settle();
                self.end(start, "hidden");
                self.recover_initial = false;
                self.opening_hint = None;
            }
        }
        match scene.kind {
            "pre_match" => {
                let new = self.pre_last.is_none_or(|v| t - v >= 10.);
                self.pre_last = Some(t);
                self.recover_initial = false;
                self.opening_hint = None;
                if new && self.pending.is_none() {
                    if self.end_pending.is_some() {
                        self.settle();
                    } else {
                        self.end(t, "next_match");
                    }
                    self.pending = Some(t);
                    self.event("match_pending", t, "pre_match");
                }
            }
            "lobby" => {
                self.recover_initial = false;
                self.opening_hint = None;
                if self.pending.take().is_some() {
                    self.event("match_cancel", t, "lobby");
                }
                self.pre_last = None;
                let first = *self.lobby_first.get_or_insert(t);
                if self.active.is_some() {
                    self.end_pending = Some(first);
                    self.end_pending_left = false;
                }
            }
            "in_match_hud" => {
                self.end_pending = None;
                self.end_pending_left = false;
                if let Some(start) = self.pending.take() {
                    self.start(start, "opening_confirmed");
                } else if self.active.is_none() && self.recover_initial {
                    self.start(first, "initial_match");
                } else if self.active.is_none() {
                    let start = *self.hud_first.get_or_insert(t);
                    if t - start >= 3. {
                        match self.opening_hint {
                            Some(opening) => self.start(opening, "opening_screen"),
                            None => self.start(start, "hud_resume"),
                        }
                    }
                }
            }
            _ if scene.match_context && self.active.is_none() && self.recover_initial => {
                self.start(first, "initial_summary")
            }
            _ => (),
        }
        if self.end_pending.is_some() && scene.kind != "lobby" && scene.kind != "in_match_hud" {
            self.end_pending_left = true;
        }
        if self.end_pending.is_some_and(|v| t - v >= 3.) {
            self.settle();
        }
        Ok(self.events[n..].to_vec())
    }
    pub fn finish(&mut self, end: f64) -> Result<Vec<MatchEvent>> {
        if !end.is_finite() || end < self.last.unwrap_or(0.) {
            bail!("End time cannot precede the last frame");
        }
        if self.finished {
            return Ok(vec![]);
        }
        let n = self.events.len();
        if self.end_pending_left {
            self.settle();
        }
        self.end(end, "eof");
        if self.pending.take().is_some() {
            self.event("match_cancel", end, "eof");
        }
        self.finished = true;
        Ok(self.events[n..].to_vec())
    }
}
pub struct VideoFrames {
    path: String,
    fps: f64,
    codec: String,
    plans: VecDeque<(bool, &'static str)>,
    k: usize,
    child: Option<Child>,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    worker: Option<thread::JoinHandle<()>>,
    hw: bool,
}
impl VideoFrames {
    pub fn new(path: &str, fps: f64, hwaccel: bool, codec: &str) -> Self {
        let mut plans = VecDeque::new();
        if hwaccel {
            plans.push_back((true, "nv12"));
            plans.push_back((true, "p010le"));
        }
        plans.push_back((false, "nv12"));
        Self {
            path: path.into(),
            fps,
            codec: codec.into(),
            plans,
            k: 0,
            child: None,
            stderr: Arc::default(),
            worker: None,
            hw: false,
        }
    }
    fn reap(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
    fn spawn(&mut self) -> Result<bool> {
        while let Some((hw, fmt)) = self.plans.pop_front() {
            let gpu = decode::is_gpu_path(Some(&self.codec), hw);
            if fmt == "p010le" && (self.k > 0 || !gpu) {
                continue;
            }
            let mut filter = format!("fps={}:round=up", self.fps);
            if gpu {
                filter += &format!(",hwdownload,format={fmt}");
            }
            filter += ",scale=640:360";
            let mut c = crate::process::spawn(
                Command::new(ffbin::ffmpeg()?)
                    .args(["-v", "error", "-nostdin"])
                    .args(decode::build_input_args(
                        Some(&self.codec),
                        hw,
                        self.k as f64 / self.fps,
                    ))
                    .args([
                        "-i", &self.path, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", &filter,
                        "-pix_fmt", "gray", "-threads", "1", "-f", "rawvideo", "pipe:1",
                    ])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped()),
            )?;
            self.stderr.lock().unwrap().clear();
            let mut err = c.stderr.take().unwrap();
            let tail = self.stderr.clone();
            self.worker = Some(thread::spawn(move || {
                let mut buf = [0; 4096];
                while let Ok(n) = err.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut t = tail.lock().unwrap();
                    t.extend(&buf[..n]);
                    while t.len() > decode::STDERR_LIMIT {
                        t.pop_front();
                    }
                }
            }));
            self.child = Some(c);
            self.hw = hw;
            return Ok(true);
        }
        Ok(false)
    }
}
impl Iterator for VideoFrames {
    type Item = Result<(f64, Image<u8>)>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.child.is_none() {
                match self.spawn() {
                    Ok(true) => (),
                    Ok(false) => return None,
                    Err(e) => return Some(Err(e)),
                }
            }
            let mut data = vec![0; 640 * 360];
            let mut got = 0;
            while got < data.len() {
                match self
                    .child
                    .as_mut()
                    .unwrap()
                    .stdout
                    .as_mut()
                    .unwrap()
                    .read(&mut data[got..])
                {
                    Ok(0) => break,
                    Ok(n) => got += n,
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(e) => return Some(Err(e.into())),
                }
            }
            if got == data.len() {
                let t = self.k as f64 / self.fps;
                self.k += 1;
                return Some(Image::new(640, 360, 1, data).map(|f| (t, f)));
            }
            let status = self.child.as_mut().unwrap().wait();
            let hw = self.hw;
            self.reap();
            if status.as_ref().is_ok_and(|s| s.success()) && got == 0 {
                self.plans.clear();
                return None;
            }
            if !hw {
                self.plans.clear();
                return Some(Err(DecodeError {
                    message: format!(
                        "Scene decoding failed ({}, frame bytes {got}/{})",
                        status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1),
                        640 * 360
                    ),
                    stderr_tail: String::from_utf8_lossy(
                        &self
                            .stderr
                            .lock()
                            .unwrap()
                            .iter()
                            .copied()
                            .collect::<Vec<_>>(),
                    )
                    .into_owned(),
                }
                .into()));
            }
        }
    }
}
impl Drop for VideoFrames {
    fn drop(&mut self) {
        self.reap();
    }
}
pub fn analyze_matches(
    path: &str,
    fps: f64,
    timeline: bool,
    hwaccel: bool,
    layout: Option<Layout>,
    scene_dir: Option<&Path>,
) -> Result<Value> {
    if !fps.is_finite() || fps <= 0. {
        bail!("fps must be a finite positive number");
    }
    let info = probe::probe(path)?;
    let (layout, _) = aspect::resolve_layout(layout, &info);
    let layout = match layout {
        Some(l) => l,
        None => aspect::detect_aspect(path, &info, scene_dir, hwaccel, None)?.layout,
    };
    let detector = SceneMatcher::new(scene_dir)?;
    let mut tracker = MatchTracker::new(1. / fps)?.backdate_openings();
    let mut scenes = vec![];
    for frame in VideoFrames::new(path, fps, hwaccel, &info.codec) {
        let (t, frame) = frame?;
        if t >= info.duration {
            break;
        }
        let scene = detector.classify_frame(&frame, layout, false)?;
        tracker.feed(t, &scene)?;
        if timeline {
            scenes.push(json!([t, scene.kind]));
        }
    }
    tracker.finish(info.duration)?;
    let mut doc = json!({"matches":tracker.matches});
    if timeline {
        doc["timeline"] = json!(scenes);
    }
    Ok(doc)
}
