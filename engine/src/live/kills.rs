use crate::{
    calibrate::{self, AnchorCollector},
    control_feed::ControlFeed,
    cv::Image,
    detect::{Detector, Keywords, Prepared},
    events::EventTracker,
    icon_detect::{IconDetector, IconFrame, DEFAULT_SCALES},
    models::{Event, FrameResult, SpecInterval},
    profile::Profile,
};
use anyhow::Result;
use image::ImageEncoder;
fn png(img: &Image<u8>) -> Result<Vec<u8>> {
    let mut data = img.data.clone();
    for p in data.as_chunks_mut::<3>().0.iter_mut() {
        p.swap(0, 2);
    }
    let mut out = vec![];
    image::codecs::png::PngEncoder::new_with_quality(
        &mut out,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Adaptive,
    )
    .write_image(
        &data,
        img.width as u32,
        img.height as u32,
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}
fn unpng(bytes: &[u8]) -> Result<Image<u8>> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)?.into_rgb8();
    let (w, h) = img.dimensions();
    let mut data = img.into_raw();
    for p in data.as_chunks_mut::<3>().0.iter_mut() {
        p.swap(0, 2);
    }
    Image::new(w as usize, h as usize, 3, data)
}
fn empty(spectating: bool) -> Prepared {
    Prepared::Ready(FrameResult {
        kind: None,
        score: 0.,
        x: 0,
        damage_line: false,
        name_sig: None,
        spectating,
        hint: None,
    })
}
type CalFrame = (f64, bool, Option<(Vec<u8>, Vec<u8>)>);
struct Calibration {
    probe: IconDetector,
    multi: IconDetector,
    det: Detector,
    hits: Vec<f64>,
    scanned: f64,
    frames: Vec<CalFrame>,
    bytes: usize,
}
impl Calibration {
    fn new(p: &Profile) -> Result<Self> {
        Ok(Self {
            probe: IconDetector::new(&p.dir, &[1.], None, false)?,
            multi: IconDetector::new(&p.dir, &DEFAULT_SCALES, None, false)?,
            det: Detector::new(p, 1., None, None)?,
            hits: vec![],
            scanned: 0.,
            frames: vec![],
            bytes: 0,
        })
    }
    fn feed(&mut self, t: f64, b: &Image<u8>, s: &Image<u8>) -> Result<()> {
        let f = self.multi.features(b)?;
        self.scanned += 0.25;
        if self.probe.chev_best(b)?.0 >= 0.45
            && f.chev >= self.multi.p.chev_min
            && f.plus >= self.multi.p.plus_min
        {
            self.hits.push(f.chev_scale);
        }
        let plain = self.det.mixtape.detect(b, s)?;
        if plain.as_ref().is_some_and(|r| r.kind.is_some()) {
            self.hits.push(1.);
        }
        if f.chev >= self.multi.p.chev_min
            || f.skull.max(f.hand) >= self.multi.p.left_min
            || plain.is_some()
        {
            let (b, s) = (png(b)?, png(s)?);
            self.bytes += b.len() + s.len();
            self.frames.push((t, false, Some((b, s))));
        } else {
            self.frames.push((t, self.det.spectating(s)?, None));
        }
        Ok(())
    }
}
#[derive(Clone, Copy)]
pub struct KillLimits {
    pub calib_scan: f64,
    pub calib_bytes: usize,
    pub learn_seconds: f64,
    pub pending_bytes: usize,
    pub late_bytes: usize,
}
impl Default for KillLimits {
    fn default() -> Self {
        Self {
            calib_scan: 600.,
            calib_bytes: 64 * 1024 * 1024,
            learn_seconds: calibrate::LEARN_SCAN_SECONDS,
            pending_bytes: 64 * 1024 * 1024,
            late_bytes: 128 * 1024 * 1024,
        }
    }
}
#[derive(Default)]
struct DerivedSnapshot {
    events: Vec<Event>,
    spec: Vec<SpecInterval>,
    derived: Vec<Event>,
}
pub struct LiveKills {
    profile: Profile,
    pub control: Option<ControlFeed>,
    limits: KillLimits,
    calib: Option<Calibration>,
    pub h_scale: Option<f64>,
    detector: Option<Detector>,
    tracker: Option<EventTracker>,
    col: Option<AnchorCollector>,
    buf: Option<Vec<(f64, Prepared)>>,
    buf_bytes: usize,
    provisional: Option<EventTracker>,
    pub keywords: Option<Keywords>,
    pub degraded: Vec<String>,
    pub revision: u64,
    head_col: Option<AnchorCollector>,
    head_kw: Option<Keywords>,
    late_col: Option<AnchorCollector>,
    late_from: f64,
    late_groups: usize,
    replay: Option<Vec<(f64, Prepared)>>,
    replay_bytes: usize,
    pub logs: Vec<String>,
    snapshot_cache: std::cell::RefCell<DerivedSnapshot>,
}
impl LiveKills {
    pub fn new(p: &Profile, limits: KillLimits) -> Result<Self> {
        Ok(Self {
            profile: p.clone(),
            control: if p.killfeed_roi.is_some() {
                Some(ControlFeed::new(p)?)
            } else {
                None
            },
            limits,
            calib: Some(Calibration::new(p)?),
            h_scale: None,
            detector: None,
            tracker: None,
            col: None,
            buf: None,
            buf_bytes: 0,
            provisional: None,
            keywords: None,
            degraded: vec![],
            revision: 0,
            head_col: None,
            head_kw: None,
            late_col: None,
            late_from: 0.,
            late_groups: 0,
            replay: None,
            replay_bytes: 0,
            logs: vec![],
            snapshot_cache: std::cell::RefCell::new(DerivedSnapshot::default()),
        })
    }
    pub fn phase(&self) -> &str {
        if self.calib.is_some() {
            "calibrating"
        } else if self.buf.is_some() {
            "learning"
        } else {
            "detecting"
        }
    }
    pub fn feed(
        &mut self,
        t: f64,
        b: &Image<u8>,
        s: &Image<u8>,
        feed: Option<&Image<u8>>,
        thumb: Option<&Image<u8>>,
    ) -> Result<()> {
        self.revision += 1;
        let mut blank = None;
        if let Some(c) = &mut self.control {
            c.feed(t, feed, s, thumb)?;
            if c.active {
                let mut z = b.clone();
                z.data.fill(0);
                blank = Some(z);
            }
        }
        let b = blank.as_ref().unwrap_or(b);
        if let Some(c) = &mut self.calib {
            c.feed(t, b, s)?;
            if c.hits.len() >= 5
                || c.scanned >= self.limits.calib_scan - 1e-6
                || c.bytes > self.limits.calib_bytes
            {
                self.calibrated()?;
            }
            return Ok(());
        }
        self.detect(t, b, s)
    }
    fn calibrated(&mut self) -> Result<()> {
        let c = self.calib.take().unwrap();
        let scale = calibrate::pick_scale(&c.hits);
        self.h_scale = Some(scale);
        if c.bytes > self.limits.calib_bytes {
            self.degraded.push("calib_buffer_cap".into());
        }
        self.logs.push(format!(
            "Icon scale {scale:?} ({} hits, scanned {:.1} seconds, buffered {} frames / {} KB)",
            c.hits.len(),
            c.scanned,
            c.frames.len(),
            c.bytes / 1024
        ));
        self.detector = Some(Detector::new(&self.profile, scale, None, None)?);
        self.tracker = Some(EventTracker::new(&self.profile, None));
        self.col = Some(AnchorCollector::default());
        self.buf = Some(vec![]);
        self.buf_bytes = 0;
        self.provisional = Some(EventTracker::new(&self.profile, None));
        for (t, spec, images) in c.frames {
            if let Some((b, s)) = images {
                self.detect(t, &unpng(&b)?, &unpng(&s)?)?;
            } else {
                self.route(t, None, empty(spec), None)?;
            }
        }
        Ok(())
    }
    fn detect(&mut self, t: f64, b: &Image<u8>, s: &Image<u8>) -> Result<()> {
        let (r, f) = self.detector.as_ref().unwrap().prepare(b, s)?;
        self.route(t, Some(b), r, Some(&f))
    }
    fn route(
        &mut self,
        t: f64,
        b: Option<&Image<u8>>,
        r: Prepared,
        f: Option<&IconFrame>,
    ) -> Result<()> {
        if let Some(col) = &mut self.col {
            if t < self.limits.learn_seconds - 1e-6 {
                if let (Some(b), Some(f)) = (b, f) {
                    col.feed_features(t, b, f, self.detector.as_ref().unwrap())?;
                }
            }
            if t >= self.limits.learn_seconds - 1e-6 || col.full(t) {
                self.learned(Some(t))?;
            }
        }
        if self.buf.is_none() {
            let result = self.detector.as_ref().unwrap().resolve(&r)?;
            self.tracker.as_mut().unwrap().feed(t, result);
            if self.replay.is_some() {
                self.late(t, b, r, f)?;
            }
            return Ok(());
        }
        self.buf.as_mut().unwrap().push((t, r.clone()));
        self.provisional
            .as_mut()
            .unwrap()
            .feed(t, self.detector.as_ref().unwrap().resolve(&r)?);
        if let Prepared::Pending(p) = r {
            self.buf_bytes += p.ink.data.len() * 4;
            if self.buf_bytes > self.limits.pending_bytes {
                self.logs.push(
                    "Pending validation buffer reached its limit; learning keywords early".into(),
                );
                self.degraded.push("pending_buffer_cap".into());
                self.learned(Some(t))?;
            }
        }
        Ok(())
    }
    fn learned(&mut self, t: Option<f64>) -> Result<()> {
        let Some(col) = self.col.take() else {
            return Ok(());
        };
        let kw = calibrate::build_keywords(std::slice::from_ref(&col))?;
        self.keywords = Some(kw.clone());
        self.detector
            .as_mut()
            .unwrap()
            .set_keywords(Some(kw.clone()));
        let buf = self.buf.take().unwrap_or_default();
        self.provisional = None;
        self.logs.push(format!(
            "Keyword learning complete ({} buffered frames)",
            buf.len()
        ));
        for (bt, br) in &buf {
            self.tracker
                .as_mut()
                .unwrap()
                .feed(*bt, self.detector.as_ref().unwrap().resolve(br)?);
        }
        if let Some(t) = t.filter(|_| !calibrate::keywords_complete(Some(&kw))) {
            self.head_col = Some(col);
            self.head_kw = Some(kw);
            self.late_col = Some(AnchorCollector::default());
            self.late_from = if t >= self.limits.learn_seconds - 1e-6 {
                self.limits.learn_seconds
            } else {
                t + 0.25
            };
            self.replay = Some(vec![]);
            self.replay_bytes = 0;
            for (bt, br) in buf {
                self.record(bt, br);
            }
            self.logs.push("Too few kills at the start to learn all keyword templates; continuing extended learning".into());
        }
        Ok(())
    }
    fn record(&mut self, t: f64, r: Prepared) {
        self.replay_bytes += 400
            + if let Prepared::Pending(p) = &r {
                p.ink.data.len() * 4
            } else {
                0
            };
        self.replay.as_mut().unwrap().push((t, r));
    }
    fn late(
        &mut self,
        t: f64,
        b: Option<&Image<u8>>,
        r: Prepared,
        f: Option<&IconFrame>,
    ) -> Result<()> {
        self.record(t, r);
        if self.replay_bytes > self.limits.late_bytes {
            self.logs.push(
                "Extended learning frame history reached its limit; stopping extended learning"
                    .into(),
            );
            self.degraded.push("late_learn_cap".into());
            self.settle()?;
            self.replay = None;
            self.late_col = None;
            return Ok(());
        }
        if t >= self.late_from - 1e-6 {
            if let (Some(b), Some(f)) = (b, f) {
                let col = self.late_col.as_mut().unwrap();
                col.feed_features(t, b, f, self.detector.as_ref().unwrap())?;
                let groups = col.hand.groups.len() + col.knock.groups.len();
                if groups != self.late_groups {
                    self.late_groups = groups;
                    self.settle()?;
                }
                if self.late_col.as_ref().unwrap().full(t) {
                    self.settle()?;
                    self.replay = None;
                    self.late_col = None;
                }
            }
        }
        Ok(())
    }
    fn settle(&mut self) -> Result<()> {
        let Some(late) = &self.late_col else {
            return Ok(());
        };
        let kw = calibrate::extend_keywords(
            self.head_kw.as_ref().unwrap(),
            &calibrate::build_keywords(&[self.head_col.as_ref().unwrap().clone(), late.clone()])?,
        );
        if calibrate::same_keywords(Some(&kw), self.keywords.as_ref()) {
            return Ok(());
        }
        self.keywords = Some(kw.clone());
        self.detector.as_mut().unwrap().set_keywords(Some(kw));
        let mut tracker = EventTracker::new(&self.profile, None);
        for (t, r) in self.replay.as_ref().unwrap() {
            tracker.feed(*t, self.detector.as_ref().unwrap().resolve(r)?);
        }
        self.tracker = Some(tracker);
        self.logs.push(format!(
            "Extended learning added keyword templates; reclassifying {} frames",
            self.replay.as_ref().unwrap().len()
        ));
        Ok(())
    }
    fn derived(
        &self,
        mut events: Vec<Event>,
        spec: Vec<SpecInterval>,
    ) -> (Vec<Event>, Vec<SpecInterval>) {
        if let Some(c) = &self.control {
            events.extend(c.events.clone());
        }
        let mut cache = self.snapshot_cache.borrow_mut();
        if cache.events != events || cache.spec != spec {
            cache.derived = crate::derive::derive(&events, &spec, &self.profile);
            cache.events = events;
            cache.spec = spec.clone();
        }
        (cache.derived.clone(), spec)
    }
    pub fn snapshot(&self) -> (Vec<Event>, Vec<SpecInterval>) {
        let src = if self.buf.is_some() {
            self.provisional.as_ref()
        } else {
            self.tracker.as_ref()
        };
        let (e, s) = src.map(EventTracker::snapshot).unwrap_or_default();
        self.derived(e, s)
    }
    pub fn finish(&mut self) -> Result<(Vec<Event>, Vec<SpecInterval>)> {
        if self.calib.is_some() {
            self.calibrated()?;
        }
        self.learned(None)?;
        self.settle()?;
        let (e, s) = self.tracker.take().unwrap().finish();
        Ok(self.derived(e, s))
    }
}

#[cfg(test)]
#[path = "kills_tests.rs"]
mod tests;
