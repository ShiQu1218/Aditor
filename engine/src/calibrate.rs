use crate::{
    cv::Image,
    decode::{DecodeOptions, FrameStream},
    detect::{consensus, crop, hand_strip, knock_strip, match_best, row_ink, Detector, Keywords},
    errors::Cancelled,
    icon_detect::{IconDetector, IconFrame, DEFAULT_SCALES},
    mixtape::MixtapeDetector,
    models::VideoInfo,
    profile::Profile,
};
use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
pub const LEARN_SCAN_SECONDS: f64 = 900.;
pub fn pick_scale(scales: &[f64]) -> f64 {
    if scales.is_empty() {
        return 1.;
    }
    let mut sorted = scales.to_vec();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len();
    let med = if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.
    };
    *DEFAULT_SCALES
        .iter()
        .min_by(|&&a, &&b| {
            (a - med)
                .abs()
                .total_cmp(&(b - med).abs())
                .then((a - 1.).abs().total_cmp(&(b - 1.).abs()))
        })
        .unwrap()
}
pub fn stopped(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|c| c.load(Ordering::Relaxed))
}
pub fn calibrate(
    path: &str,
    info: &VideoInfo,
    p: &Profile,
    max_scan: f64,
    cancel: Option<&AtomicBool>,
    hwaccel: bool,
) -> Result<f64> {
    let probe = IconDetector::new(&p.dir, &[1.], None, false)?;
    let multi = IconDetector::new(&p.dir, &DEFAULT_SCALES, None, false)?;
    let mixtape = MixtapeDetector::new(p)?;
    // Calibration consumes only banner and spectator crops, so omit unused feed and thumbnail decoding.
    let mut decode_profile = p.clone();
    // The existing crop-only stack pads spectator frames to the banner width.
    if decode_profile.capture_banner()[2] >= decode_profile.capture_spec()[2] {
        decode_profile.killfeed_roi = None;
    }
    let mid = info.duration / 2.;
    let mut hits = vec![];
    let mut scanned = 0.;
    for (start, limit) in [(mid, None), (0., Some(mid))] {
        if start == 0. && (mid <= 0. || scanned >= max_scan) {
            break;
        }
        let mut part_hits = vec![];
        let mut stream = FrameStream::new(
            path,
            decode_profile.clone(),
            DecodeOptions {
                start,
                hwaccel,
                codec: Some(info.codec.clone()),
                ..DecodeOptions::default()
            },
        );
        while let Some(frame) = stream.next_cancellable(&|| stopped(cancel)) {
            if stopped(cancel) {
                return Err(Cancelled.into());
            }
            let (t, b, s) = frame?;
            if limit.is_some_and(|l| t >= l) || scanned >= max_scan {
                break;
            }
            scanned += 0.25;
            if probe.chev_best(&b)?.0 < 0.45 {
                if mixtape.detect(&b, &s)?.is_some_and(|r| r.kind.is_some()) {
                    part_hits.push(1.);
                }
            } else {
                let f = multi.score_features(&b)?;
                if f.chev >= multi.p.chev_min && f.plus >= multi.p.plus_min {
                    part_hits.push(f.chev_scale);
                }
            }
            if part_hits.len() >= 5 {
                break;
            }
        }
        hits.extend(part_hits.into_iter().take(5 - hits.len()));
        if hits.len() >= 5 {
            break;
        }
    }
    Ok(pick_scale(&hits))
}
#[derive(Clone, Debug)]
pub struct Group {
    pub first: f64,
    pub last: f64,
    pub strips: Vec<Image<f32>>,
}
#[derive(Clone, Debug, Default)]
pub struct Anchors {
    pub groups: Vec<Group>,
}
impl Anchors {
    pub fn done(&self) -> bool {
        self.groups.len() >= 4
    }
    pub fn accepts(&self, t: f64) -> bool {
        !self.done() || self.groups.last().is_some_and(|g| t - g.last <= 2.)
    }
    pub fn add(&mut self, t: f64, strip: Image<f32>) {
        if let Some(last) = self.groups.last_mut().filter(|g| t - g.last <= 2.) {
            if last.strips.len() < 2 {
                last.strips.push(strip);
            }
            last.last = t;
        } else if !self.done() {
            self.groups.push(Group {
                first: t,
                last: t,
                strips: vec![strip],
            });
        }
    }
}
#[derive(Clone, Debug)]
pub struct AnchorCollector {
    pub hand: Anchors,
    pub knock: Anchors,
    pub assist_cands: Vec<(f64, Image<f32>, i32, i32)>,
    last_hit: f64,
}
impl Default for AnchorCollector {
    fn default() -> Self {
        Self {
            hand: Anchors::default(),
            knock: Anchors::default(),
            assist_cands: vec![],
            last_hit: -1e9,
        }
    }
}
impl AnchorCollector {
    pub fn full(&self, t: f64) -> bool {
        self.hand.done()
            && self.knock.done()
            && self.assist_cands.len() >= 80
            && t - self.last_hit > 2.
    }
    pub fn feed_features(
        &mut self,
        t: f64,
        b: &Image<u8>,
        f: &IconFrame,
        det: &Detector,
    ) -> Result<()> {
        if f.kind.as_deref() == Some("assist_elim") && f.hand >= 0.92 && self.hand.accepts(t) {
            let hand = &det.icons.tpl[4][0];
            if let Some(s) = hand_strip(b, f, (hand.height, hand.width))? {
                self.hand.add(t, s);
                self.last_hit = t;
            }
        } else if f.kind.as_deref() == Some("assist_knock")
            && self.assist_cands.len() < 80
            && f.line2_ink - f.line2_ink_bg < 0.03
            && f.name_color - f.name_color_bg < 20
        {
            self.assist_cands
                .push((t, row_ink(b, f, 5)?, f.plus_x, f.line_l));
            self.last_hit = t;
        } else if f.kind.as_deref() == Some("knock")
            && f.line2_ink - f.line2_ink_bg >= 0.05
            && self.knock.accepts(t)
        {
            if let Some(sig) = det.knock_sig(b, f)? {
                if sig.width >= 40
                    && sig.bits.iter().map(|&v| v as f64).sum::<f64>() / sig.bits.len() as f64
                        >= 0.12
                {
                    if let Some(s) = knock_strip(b, f, &det.profile)? {
                        self.knock.add(t, s);
                        self.last_hit = t;
                    }
                }
            }
        }
        Ok(())
    }
    pub fn feed(&mut self, t: f64, b: &Image<u8>, det: &Detector) -> Result<()> {
        if det.icons.maybe_banner(b)? {
            self.feed_features(t, b, &det.icons.features(b)?, det)?;
        }
        Ok(())
    }
}
pub fn merge_groups(parts: impl IntoIterator<Item = Vec<Group>>) -> Vec<Group> {
    let mut out: Vec<Group> = vec![];
    for groups in parts {
        for g in groups {
            if let Some(last) = out.last_mut().filter(|p| g.first - p.last <= 2.) {
                last.last = g.last;
                last.strips.extend(g.strips);
                last.strips.truncate(2);
            } else {
                out.push(g);
            }
        }
    }
    out.truncate(4);
    out
}
pub fn build_keywords(cols: &[AnchorCollector]) -> Result<Keywords> {
    let hand = merge_groups(cols.iter().map(|c| c.hand.groups.clone()));
    let knock = merge_groups(cols.iter().map(|c| c.knock.groups.clone()));
    let mut cands: Vec<_> = cols.iter().flat_map(|c| c.assist_cands.iter()).collect();
    cands.sort_by(|a, b| a.0.total_cmp(&b.0));
    cands.truncate(80);
    let mut kw = Keywords {
        assist: consensus(
            &hand
                .iter()
                .flat_map(|g| g.strips.clone())
                .collect::<Vec<_>>(),
            hand.len(),
        ),
        knock: consensus(
            &knock
                .iter()
                .flat_map(|g| g.strips.clone())
                .collect::<Vec<_>>(),
            knock.len(),
        ),
        assist_by_knock: false,
    };
    if let Some(tpl) = &kw.knock {
        let mut times = vec![];
        for (t, m, px, ll) in cands {
            if match_best(&crop(m, 0.max(ll - 4), 0, *px, m.height as i32), tpl)?.0 >= 0.7 {
                times.push(*t);
            }
        }
        kw.assist_by_knock = times
            .iter()
            .enumerate()
            .filter(|&(i, t)| i == 0 || *t - times[i - 1] > 2.)
            .count()
            >= 2;
    }
    Ok(kw)
}
pub fn keywords_complete(kw: Option<&Keywords>) -> bool {
    kw.is_some_and(|k| k.knock.is_some() && (k.assist.is_some() || k.assist_by_knock))
}
pub fn extend_keywords(base: &Keywords, wider: &Keywords) -> Keywords {
    Keywords {
        assist: base.assist.clone().or_else(|| wider.assist.clone()),
        knock: base.knock.clone().or_else(|| wider.knock.clone()),
        assist_by_knock: if base.knock.is_some() {
            base.assist_by_knock
        } else {
            wider.assist_by_knock
        },
    }
}
pub fn same_keywords(a: Option<&Keywords>, b: Option<&Keywords>) -> bool {
    a.cloned().unwrap_or_default() == b.cloned().unwrap_or_default()
}
#[allow(clippy::too_many_arguments)]
pub fn learn_keywords(
    path: &str,
    info: &VideoInfo,
    p: &Profile,
    scale: f64,
    jobs: usize,
    max_scan: f64,
    cancel: Option<&AtomicBool>,
    hwaccel: bool,
) -> Result<Keywords> {
    let limit = info.duration.min(max_scan);
    let abort = AtomicBool::new(false);
    let scan = |start, end| -> Result<AnchorCollector> {
        let det = Detector::new(p, scale, None, None)?;
        let mut col = AnchorCollector::default();
        let mut stream = FrameStream::new(
            path,
            p.clone(),
            DecodeOptions {
                start,
                end: Some(end),
                hwaccel,
                codec: Some(info.codec.clone()),
            },
        );
        while let Some(frame) =
            stream.next_cancellable(&|| stopped(cancel) || abort.load(Ordering::Relaxed))
        {
            if stopped(cancel) || abort.load(Ordering::Relaxed) {
                return Err(Cancelled.into());
            }
            let (t, b, _) = frame?;
            col.feed(t, &b, &det)?;
            if col.full(t) {
                break;
            }
        }
        Ok(col)
    };
    let spans = crate::analyze::plan_segments(limit, jobs, 30.);
    let mut cols = std::thread::scope(|scope| -> Result<Vec<AnchorCollector>> {
        let handles: Vec<_> = spans
            .into_iter()
            .map(|(start, end)| {
                let scan = &scan;
                let abort = &abort;
                scope.spawn(move || {
                    let r = scan(start, end);
                    if r.is_err() {
                        abort.store(true, Ordering::Relaxed);
                    }
                    r
                })
            })
            .collect();
        let mut cols = vec![];
        let mut error: Option<anyhow::Error> = None;
        for handle in handles {
            match handle
                .join()
                .unwrap_or_else(|_| Err(anyhow::anyhow!("Keyword worker panicked")))
            {
                Ok(col) => cols.push(col),
                Err(e) => {
                    if error
                        .as_ref()
                        .is_none_or(|old| old.is::<Cancelled>() && !e.is::<Cancelled>())
                    {
                        error = Some(e);
                    }
                }
            }
        }
        error.map_or(Ok(cols), Err)
    })?;
    let base = build_keywords(&cols)?;
    if keywords_complete(Some(&base)) || limit >= info.duration {
        return Ok(base);
    }
    cols.push(scan(limit, info.duration)?);
    Ok(extend_keywords(&base, &build_keywords(&cols)?))
}
