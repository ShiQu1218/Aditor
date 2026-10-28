mod feed;
mod profile;
mod tracker;
pub use crate::game_detect::scoreboard_visible;
use crate::{
    analyze::{save, AnalyzeOptions},
    cache,
    cv::Image,
    decode::{DecodeOptions, FrameStream},
    models::{Clip, Event, SpecInterval, VideoInfo},
    valorant_rounds::{round_highlights, Round, RoundTracker},
};
use anyhow::Result;
pub use feed::*;
pub use profile::*;
use serde_json::{json, Value};
pub use tracker::*;
pub struct ValorantLiveKills {
    pub detector: FeedDetector,
    pub tracker: FeedTracker,
    pub round_tracker: RoundTracker,
    pub revision: u64,
    pub degraded: Vec<String>,
    pub h_scale: Option<f64>,
}
impl ValorantLiveKills {
    pub fn new(p: &ValorantProfile) -> Self {
        Self {
            detector: FeedDetector::new(p),
            tracker: FeedTracker::default(),
            round_tracker: RoundTracker::new((740, 20), 4.),
            revision: 0,
            degraded: vec![],
            h_scale: Some(1.),
        }
    }
    pub fn feed(&mut self, t: f64, b: &Image<u8>, s: &Image<u8>) -> Result<()> {
        let rows = self.detector.observations(b)?;
        if !self.tracker.feed(t, &rows).is_empty() {
            self.revision += 1;
        }
        if self.round_tracker.feed(t, s)?.is_some() {
            self.revision += 1;
        }
        Ok(())
    }
    pub fn snapshot(&self) -> (Vec<Event>, Vec<SpecInterval>) {
        let mut events = self.tracker.events.clone();
        events.extend(round_highlights(&events, &self.round_tracker.rounds));
        events.sort_by(|a, b| a.t.total_cmp(&b.t));
        (events, vec![])
    }
    pub fn finish(&mut self) -> (Vec<Event>, Vec<SpecInterval>) {
        self.snapshot()
    }
}
pub fn merge_events(
    base: &[Event],
    detected: &[Event],
    rounds: &[Round],
) -> (Vec<Event>, Vec<Event>) {
    let auto = |e: &&Event| matches!(e.kind.as_str(), "multikill" | "ace") && e.source != "manual";
    let regular: Vec<_> = base.iter().filter(|e| !auto(e)).cloned().collect();
    let old: Vec<_> = base.iter().filter(auto).cloned().collect();
    let (mut events, mut unmatched) = cache::merge_reanalysis(&regular, detected);
    let (highlights, lost) = cache::merge_reanalysis(&old, &round_highlights(&events, rounds));
    events.extend(highlights);
    unmatched.extend(lost);
    events.sort_by(|a, b| a.t.total_cmp(&b.t));
    (events, unmatched)
}
pub fn analyze_valorant(
    path: &str,
    info: &VideoInfo,
    p: &ValorantProfile,
    opts: AnalyzeOptions<'_>,
    source: &str,
) -> Result<Value> {
    let (cp, old) = cache::prepare_cache(path, opts.cache_dir, opts.beside);
    if !opts.force
        && !cache::needs_reanalysis(
            old.as_ref(),
            info,
            &p.templates_version,
            Some(p.layout.squash),
            "valorant",
        )
    {
        let mut doc = old.unwrap();
        doc["cache_path"] = cp.to_string_lossy().as_ref().into();
        return Ok(doc);
    }
    let old = old.unwrap_or(Value::Null);
    let base: Vec<Event> = if old["analysis"]["status"] == "done" {
        serde_json::from_value(old.get("events").cloned().unwrap_or(json!([])))?
    } else {
        vec![]
    };
    let clips: Vec<Clip> = serde_json::from_value(old.get("clips").cloned().unwrap_or(json!([])))?;
    let clips = cache::merge_clips(&clips, &[]);
    let mut kills = ValorantLiveKills::new(p);
    let mut stream = FrameStream::for_capture(
        path,
        p.decoder_profile(),
        DecodeOptions {
            hwaccel: opts.hwaccel,
            codec: Some(info.codec.clone()),
            ..Default::default()
        },
        p.capture_banner,
        p.capture_spec,
    );
    let mut last = -1.;
    while let Some(frame) = stream.next_cancellable(&|| crate::calibrate::stopped(opts.cancel)) {
        if crate::calibrate::stopped(opts.cancel) {
            return Err(crate::errors::Cancelled.into());
        }
        let (t, b, s) = frame?;
        let (b, s) = p.restore(&b, &s)?;
        kills.feed(t, &b, &s)?;
        if t - last >= 1. {
            (opts.on_progress)(t, info.duration);
            last = t;
        }
    }
    let (events, unmatched) =
        merge_events(&base, &kills.tracker.events, &kills.round_tracker.rounds);
    let mut doc = json!({"version":1,"game":"valorant","video":info,"analysis":{"status":"done","progress_t":info.duration,"engine_version":cache::ENGINE_VERSION,"templates_version":p.templates_version,"h_scale":1.0,"aspect_squash":p.layout.squash,"aspect_source":source},"events":events,"spectating":[],"clips":clips,"rounds":kills.round_tracker.rounds,"keyframes":crate::probe::keyframes(path).unwrap_or_default(),"unmatched":unmatched});
    save(&cp, &mut doc, opts.cache_dir)?;
    (opts.on_progress)(info.duration, info.duration);
    Ok(doc)
}
