mod kills;
mod shm;
use crate::{
    cv::Image,
    layout::Layout,
    matches::MatchTracker,
    models::{Event, SpecInterval},
    profile::Profile,
    scene::SceneMatcher,
    valorant::{ValorantLiveKills, ValorantProfile},
};
use anyhow::Result;
pub use kills::{KillLimits, LiveKills};
use serde_json::{json, Value};
pub use shm::*;
use std::{
    io::{BufRead, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
pub fn process_cpu_seconds() -> Result<f64> {
    use windows::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    // SAFETY: The pseudo-handle is valid and FILETIME outputs are writable for the duration of the call.
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )?;
    }
    let ticks = |v: FILETIME| ((v.dwHighDateTime as u64) << 32) | v.dwLowDateTime as u64;
    Ok((ticks(kernel) + ticks(user)) as f64 / 10_000_000.)
}
pub enum LiveProfile {
    Apex(Box<Profile>),
    Valorant(ValorantProfile),
}
impl LiveProfile {
    fn layout(&self) -> Layout {
        match self {
            Self::Apex(p) => p.layout,
            Self::Valorant(p) => p.layout,
        }
    }
    fn capture(&self) -> ([i32; 4], [i32; 4]) {
        match self {
            Self::Apex(p) => (p.capture_banner(), p.capture_spec()),
            Self::Valorant(p) => (p.capture_banner, p.capture_spec),
        }
    }
    fn restore(&self, b: &Image<u8>, s: &Image<u8>) -> Result<(Image<u8>, Image<u8>)> {
        match self {
            Self::Apex(p) => p.restore(b, s),
            Self::Valorant(p) => p.restore(b, s),
        }
    }
}
enum Kills {
    Apex(Box<LiveKills>),
    Valorant(Box<ValorantLiveKills>),
}
impl Kills {
    fn snapshot(&self) -> (Vec<Event>, Vec<SpecInterval>) {
        match self {
            Self::Apex(k) => k.snapshot(),
            Self::Valorant(k) => k.snapshot(),
        }
    }
    fn finish(&mut self) -> Result<(Vec<Event>, Vec<SpecInterval>)> {
        match self {
            Self::Apex(k) => k.finish(),
            Self::Valorant(k) => Ok(k.finish()),
        }
    }
    fn scale(&self) -> Option<f64> {
        match self {
            Self::Apex(k) => k.h_scale,
            Self::Valorant(k) => k.h_scale,
        }
    }
    fn degraded(&self) -> &[String] {
        match self {
            Self::Apex(k) => &k.degraded,
            Self::Valorant(k) => &k.degraded,
        }
    }
}
pub fn check_layout(l: ShmLayout, p: &LiveProfile, needs_thumb: bool) -> Result<()> {
    let fail = |s: String| anyhow::Error::new(LayoutError(s));
    let (b, s) = p.capture();
    let capture = (
        (b[2] as usize, b[3] as usize),
        (s[2] as usize, s[3] as usize),
    );
    let reference = match p {
        LiveProfile::Apex(p) => Some((
            (p.banner_roi[2] as usize, p.banner_roi[3] as usize),
            (p.spec_roi[2] as usize, p.spec_roi[3] as usize),
        )),
        _ => None,
    };
    let feed = match p {
        LiveProfile::Apex(p) => p.capture_killfeed().map(|r| (r[2] as usize, r[3] as usize)),
        _ => None,
    };
    if l.killfeed != (0, 0) && Some(l.killfeed) != feed {
        return Err(fail("Kill-feed dimensions do not match the profile".into()));
    }
    if (l.banner, l.spec) != capture
        && !(reference == Some((l.banner, l.spec)) && p.layout().identity())
    {
        return Err(fail(format!("banner/spec dimensions {:?}/{:?} do not match profile capture ROIs {:?}/{:?} for aspect squash {}",l.banner,l.spec,capture.0,capture.1,p.layout().squash)));
    }
    if needs_thumb && (l.thumb.0 < 640 || l.thumb.1 < 360) {
        return Err(fail(format!(
            "thumb {:?} is smaller than required for scene detection ((640, 360))",
            l.thumb
        )));
    }
    Ok(())
}
pub struct LiveEngine {
    pub reader: ShmReader,
    pub profile: LiveProfile,
    scene: Option<SceneMatcher>,
    kills: Kills,
    matches: MatchTracker,
    pub next_seq: Option<u64>,
    pub last_t: Option<f64>,
    pub last_pts: Option<i64>,
    pub frames: u64,
    pub skipped: u64,
    pub torn: u64,
    initial_skipped: u64,
    restore: bool,
    start: Instant,
    last_snap: f64,
    last_stats: f64,
    snap_doc: Value,
    win_frames: u64,
    win_cpu: f64,
    pub cpu_total: f64,
}
impl LiveEngine {
    pub fn new(
        reader: ShmReader,
        profile: LiveProfile,
        scene: Option<SceneMatcher>,
    ) -> Result<Self> {
        let (b, _) = profile.capture();
        let restore = reader.layout().banner == (b[2] as usize, b[3] as usize);
        let kills = match &profile {
            LiveProfile::Apex(p) => {
                Kills::Apex(Box::new(LiveKills::new(p, KillLimits::default())?))
            }
            LiveProfile::Valorant(p) => Kills::Valorant(Box::new(ValorantLiveKills::new(p))),
        };
        let mut e = Self {
            reader,
            profile,
            scene,
            kills,
            matches: MatchTracker::new(1.)?,
            next_seq: None,
            last_t: None,
            last_pts: None,
            frames: 0,
            skipped: 0,
            torn: 0,
            initial_skipped: 0,
            restore,
            start: Instant::now(),
            last_snap: -1.,
            last_stats: 0.,
            snap_doc: Value::Null,
            win_frames: 0,
            win_cpu: 0.,
            cpu_total: 0.,
        };
        e.snap_doc = e.body((vec![], vec![]));
        Ok(e)
    }
    pub fn grid_time(&self, pts: i64) -> Option<f64> {
        let raw = (pts as f64 / 10_000_000.).max(0.);
        let mut t = (raw / 0.25).round_ties_even() * 0.25;
        if self.last_t.is_some_and(|v| t <= v + 1e-6) {
            t = self.last_t.unwrap() + 0.25;
            if t - raw > 0.25 + 1e-6 {
                return None;
            }
        }
        Some(t)
    }
    fn process(&mut self, slot: Slot, out: &mut Vec<Value>) -> Result<bool> {
        let Some(t) = self.grid_time(slot.pts) else {
            self.skipped += 1;
            return Ok(false);
        };
        let start = process_cpu_seconds()?;
        let (b, s) = if self.restore {
            self.profile.restore(&slot.banner, &slot.spec)?
        } else {
            (slot.banner, slot.spec)
        };
        match &mut self.kills {
            Kills::Apex(k) => {
                let feed = if let (LiveProfile::Apex(p), Some(f)) = (&self.profile, &slot.killfeed)
                {
                    if p.killfeed_roi.is_some() {
                        Some(p.restore_killfeed(f)?)
                    } else {
                        None
                    }
                } else {
                    None
                };
                k.feed(t, &b, &s, feed.as_ref(), slot.thumb.as_ref())?;
                for msg in k.logs.drain(..) {
                    eprintln!("[live] {msg}");
                }
            }
            Kills::Valorant(k) => k.feed(t, &b, &s)?,
        };
        if let (Some(thumb), Some(scene)) = (&slot.thumb, &self.scene) {
            for ev in self.matches.feed(
                t,
                &scene.classify_frame(thumb, self.profile.layout(), false)?,
            )? {
                out.push(json!({"ev":ev.r#type,"t":ev.t,"reason":ev.reason}));
            }
        }
        let cpu = process_cpu_seconds()? - start;
        self.last_t = Some(t);
        self.last_pts = Some(slot.pts);
        self.frames += 1;
        self.cpu_total += cpu;
        self.win_frames += 1;
        self.win_cpu += cpu;
        Ok(true)
    }
    pub fn poll(&mut self) -> Result<(usize, Vec<Value>)> {
        let mut n = 0;
        let mut out = vec![];
        loop {
            let latest = self.reader.latest();
            if latest == 0 {
                break;
            }
            if self.next_seq.is_none() {
                let seq = latest.saturating_sub(7).max(1);
                self.next_seq = Some(seq);
                self.initial_skipped = seq - 1;
                self.skipped = self.skipped.saturating_add(seq - 1);
            }
            let mut seq = self.next_seq.unwrap();
            if latest < seq {
                break;
            }
            if latest - seq + 1 > 16 {
                self.skipped = self.skipped.saturating_add(latest - seq);
                seq = latest;
            }
            self.next_seq = Some(
                seq.checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("Shared-memory sequence number exhausted"))?,
            );
            let Some(slot) = self.reader.read(seq) else {
                self.torn += 1;
                continue;
            };
            if self.process(slot, &mut out)? {
                n += 1;
            }
        }
        let now = self.start.elapsed().as_secs_f64();
        out.extend(self.tick(now)?);
        Ok((n, out))
    }
    pub fn tick(&mut self, now: f64) -> Result<Vec<Value>> {
        let mut out = vec![];
        if now - self.last_snap >= 1. {
            self.last_snap = now;
            let body = self.body(self.kills.snapshot());
            if body != self.snap_doc {
                self.snap_doc = body.clone();
                out.push(self.snapshot(body, None));
            }
        }
        if now - self.last_stats >= 5. {
            self.last_stats = now;
            out.push(self.stats());
        }
        Ok(out)
    }
    fn body(&self, pair: (Vec<Event>, Vec<SpecInterval>)) -> Value {
        let (mut body, rounds) = (
            json!({"events":pair.0,"spectating":pair.1}),
            match &self.kills {
                Kills::Valorant(k) => Some(&k.round_tracker.rounds),
                _ => None,
            },
        );
        if let Some(r) = rounds {
            body["rounds"] = json!(r);
        }
        body
    }
    fn snapshot(&self, mut body: Value, quality: Option<Value>) -> Value {
        body["ev"] = "snapshot".into();
        body["t"] = self.last_t.unwrap_or(0.).into();
        if let Some(q) = quality {
            body["final"] = true.into();
            body["quality"] = q;
        }
        body
    }
    pub fn lag_seconds(&self) -> f64 {
        self.last_pts
            .and_then(|last| {
                self.reader
                    .peek_pts(self.reader.latest())
                    .map(|pts| ((i128::from(pts) - i128::from(last)) as f64 / 10_000_000.).max(0.))
            })
            .unwrap_or(0.)
    }
    fn stats(&mut self) -> Value {
        let per = if self.win_frames > 0 {
            1000. * self.win_cpu / self.win_frames as f64
        } else {
            0.
        };
        self.win_frames = 0;
        self.win_cpu = 0.;
        json!({"ev":"stats","t":self.last_t.unwrap_or(0.),"frames":self.frames,"skipped":self.skipped,"torn":self.torn,"lag_s":(self.lag_seconds()*1000.).round_ties_even()/1000.,"cpu_ms_per_frame":(per*1000.).round_ties_even()/1000.})
    }
    pub fn quality(&self) -> Value {
        let mut reasons = self.kills.degraded().to_vec();
        if self.initial_skipped > 0 {
            reasons.push("startup_frames_lost".into());
        }
        let lost = self.skipped as f64 + self.torn as f64;
        if self.frames > 0 && lost / (self.frames as f64 + lost) > 0.01 {
            reasons.push("frames_lost".into());
        }
        json!({"complete":reasons.is_empty(),"reasons":reasons,"h_scale":self.kills.scale(),"aspect_squash":self.profile.layout().squash,"frames":self.frames,"skipped":self.skipped,"torn":self.torn})
    }
    pub fn finish(&mut self) -> Result<Vec<Value>> {
        let pair = self.kills.finish()?;
        if let Kills::Apex(k) = &mut self.kills {
            for msg in k.logs.drain(..) {
                eprintln!("[live] {msg}");
            }
        }
        let mut out = vec![];
        for ev in self.matches.finish(self.last_t.unwrap_or(0.))? {
            out.push(json!({"ev":ev.r#type,"t":ev.t,"reason":ev.reason}));
        }
        out.push(self.stats());
        out.push(self.snapshot(self.body(pair), Some(self.quality())));
        Ok(out)
    }
}
fn send(obj: &Value) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, obj)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}
fn error(code: &str, message: &str, exception: Option<&str>) -> Result<i32> {
    let mut doc = json!({"ev":"error","code":code,"message":message});
    if let Some(kind) = exception {
        doc["exception"] = json!({"type":kind,"frames":[]});
    }
    send(&doc)?;
    Ok(1)
}
pub fn run(
    shm: &str,
    profile_dir: &Path,
    scene_dir: Option<&Path>,
    aspect: Option<&str>,
    game: Option<&str>,
) -> Result<i32> {
    let game = match crate::games::resolve_game(game, None) {
        Ok(g) => g,
        Err(e) => return error("unsupported_game", &e.to_string(), None),
    };
    let load = || -> Result<(LiveProfile, Option<SceneMatcher>)> {
        let layout = aspect
            .filter(|s| !s.is_empty())
            .map(crate::layout::parse_aspect)
            .transpose()?
            .unwrap_or_default();
        if game == "valorant" {
            Ok((
                LiveProfile::Valorant(
                    crate::valorant::load_valorant_profile(profile_dir)?.with_layout(layout),
                ),
                None,
            ))
        } else {
            Ok((
                LiveProfile::Apex(Box::new(
                    crate::profile::load_profile(profile_dir)?.with_layout(layout),
                )),
                Some(SceneMatcher::new(scene_dir)?),
            ))
        }
    };
    let (profile, scene) = match load() {
        Ok(p) => p,
        Err(e) => {
            return error(
                "internal",
                &format!("Failed to load templates: {e}"),
                Some(if e.is::<crate::errors::ProfileError>() {
                    "ProfileError"
                } else if e.is::<crate::errors::ValorantProfileError>() {
                    "ValorantProfileError"
                } else if e.is::<crate::errors::LayoutError>() {
                    "LayoutError"
                } else {
                    "ValueError"
                }),
            )
        }
    };
    let reader = match ShmReader::open(shm) {
        Ok(r) => r,
        Err(e) if e.is::<LayoutError>() => return error("bad_layout", &e.to_string(), None),
        Err(e) => {
            let code = e
                .downcast_ref::<windows::core::Error>()
                .map(|e| e.code().0 as u32 & 0xffff);
            return error(
                "shm_open_failed",
                "Could not open recording shared memory",
                Some(match code {
                    Some(2) => "FileNotFoundError",
                    Some(5) => "PermissionError",
                    _ => "OSError",
                }),
            );
        }
    };
    if let Err(e) = check_layout(reader.layout(), &profile, scene.is_some()) {
        return error("bad_layout", &e.to_string(), None);
    }
    let l = reader.layout();
    send(
        &json!({"ev":"ready","engine_version":crate::cache::ENGINE_VERSION,"banner":[l.banner.0,l.banner.1],"spec":[l.spec.0,l.spec.1],"thumb":[l.thumb.0,l.thumb.1]}),
    )?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().split(b'\n') {
            match line {
                Ok(line) => {
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let parsed = serde_json::from_str::<Value>(line);
                    if parsed
                        .as_ref()
                        .is_ok_and(|v| v.is_object() && v["cmd"] == "stop")
                    {
                        break;
                    }
                    let kind = if parsed.is_err() {
                        "unparseable"
                    } else {
                        "unknown"
                    };
                    eprintln!(
                        "[live] Ignoring {kind} command: {}",
                        line.chars().take(200).collect::<String>()
                    );
                }
                Err(e) => {
                    eprintln!("[live] Failed to read stdin; treating it as a stop request: {e}");
                    break;
                }
            }
        }
        flag.store(true, Ordering::Release);
    });
    let work = || -> Result<()> {
        let mut engine = LiveEngine::new(reader, profile, scene)?;
        while !stop.load(Ordering::Acquire) {
            let (n, out) = engine.poll()?;
            for v in out {
                send(&v)?;
            }
            if n == 0 {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let (_, out) = engine.poll()?;
        for v in out {
            send(&v)?;
        }
        for v in engine.finish()? {
            send(&v)?;
        }
        Ok(())
    };
    match work() {
        Ok(()) => Ok(0),
        Err(e) => error(
            "internal",
            &format!("RuntimeError: {e}"),
            Some("RuntimeError"),
        ),
    }
}
