use crate::{
    aspect, cache, calibrate, decode, derive,
    detect::Keywords,
    errors::Cancelled,
    games,
    layout::Layout,
    models::{Clip, Event, SpecInterval, VideoInfo},
    probe,
    profile::Profile,
};
use anyhow::Result;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Mutex},
};
mod segments;
mod worker;
pub use segments::*;
use worker::{Learning, State};

pub struct AnalyzeOptions<'a> {
    pub cache_dir: &'a Path,
    pub beside: bool,
    pub force: bool,
    pub on_progress: &'a (dyn Fn(f64, f64) + Sync),
    pub cancel: Option<&'a AtomicBool>,
    pub hwaccel: bool,
    pub jobs: Option<usize>,
    pub layout: Option<Layout>,
    pub game: Option<&'a str>,
}
impl<'a> AnalyzeOptions<'a> {
    pub fn new(cache_dir: &'a Path) -> Self {
        Self {
            cache_dir,
            beside: false,
            force: false,
            on_progress: &|_, _| {},
            cancel: None,
            hwaccel: true,
            jobs: None,
            layout: None,
            game: None,
        }
    }
}
pub(crate) struct Document<'a> {
    info: &'a VideoInfo,
    profile: &'a Profile,
    scale: Option<f64>,
    source: &'a str,
    clips: Vec<Clip>,
    base: Vec<Event>,
}
impl Document<'_> {
    fn make(
        &self,
        status: &str,
        t: f64,
        events: &[Event],
        spec: &[SpecInterval],
        segments: Option<&[Segment]>,
        keywords: Option<&Keywords>,
    ) -> Value {
        let mut a = serde_json::Map::new();
        a.insert("status".into(), status.into());
        a.insert("progress_t".into(), t.into());
        a.insert("engine_version".into(), cache::ENGINE_VERSION.into());
        a.insert(
            "templates_version".into(),
            self.profile.templates_version.clone().into(),
        );
        a.insert("h_scale".into(), self.scale.into());
        a.insert("aspect_squash".into(), self.profile.layout.squash.into());
        a.insert("aspect_source".into(), self.source.into());
        if let Some(segs) = segments.filter(|s| !s.is_empty()) {
            a.insert("segments".into(), json!(segs));
        }
        if let Some(kw) = keywords {
            a.insert("keywords".into(), kw.to_dict());
        }
        let mut doc = serde_json::Map::new();
        doc.insert("version".into(), 1.into());
        doc.insert("video".into(), json!(self.info));
        doc.insert("analysis".into(), a.into());
        doc.insert("events".into(), json!(events));
        doc.insert("spectating".into(), json!(spec));
        doc.insert("clips".into(), json!(self.clips));
        doc.into()
    }
    fn partial(&self, state: Option<&State>) -> Value {
        let mut doc = if let Some(s) = state.filter(|s| s.learned().is_some()) {
            let (evs, spec) = s.combined();
            self.make(
                "partial",
                s.segs.iter().map(|s| s.contribution(s.snap_progress)).sum(),
                &evs,
                &spec,
                (s.segs.len() > 1).then_some(s.segs.as_slice()),
                s.learned(),
            )
        } else {
            self.make("partial", 0., &[], &[], None, None)
        };
        if !self.base.is_empty() {
            doc["base_events"] = json!(self.base);
        }
        doc
    }
}
pub(crate) fn save(cp: &Path, doc: &mut Value, fallback: &Path) -> Result<()> {
    doc["cache_path"] = cp.to_string_lossy().as_ref().into();
    let written = cache::save_cache(cp, doc, Some(fallback))?;
    if written != cp {
        doc["cache_path"] = written.to_string_lossy().as_ref().into();
        cache::save_cache(&written, doc, None)?;
    }
    Ok(())
}
fn resumable(old: &Value, info: &VideoInfo, p: &Profile, check_aspect: bool) -> bool {
    let a = &old["analysis"];
    a["status"] == "partial"
        && a["h_scale"].as_f64().is_some()
        && old["video"]["size"].as_u64() == Some(info.size)
        && (old["video"]["mtime"].as_f64().unwrap_or(-1.) - info.mtime).abs() < 1e-6
        && a["engine_version"] == cache::ENGINE_VERSION
        && a["templates_version"] == p.templates_version
        && if check_aspect {
            a["aspect_squash"].as_f64().unwrap_or(1.) == p.layout.squash
        } else {
            a.get("aspect_source").is_some()
        }
}
fn read_list<T: serde::de::DeserializeOwned>(v: &Value) -> Result<Vec<T>> {
    if v.is_null() {
        Ok(vec![])
    } else {
        Ok(serde_json::from_value(v.clone())?)
    }
}

pub fn analyze(path: &str, profile: &Profile, opts: AnalyzeOptions<'_>) -> Result<Value> {
    let info = probe::probe(path)?;
    let cached = if opts.force {
        None
    } else {
        cache::load_cache(&cache::resolve_cache_path(
            path,
            opts.cache_dir,
            opts.beside,
        ))
    };
    let scene = profile.dir.parent().unwrap_or(Path::new("")).join("scene");
    let scene = scene.is_dir().then_some(scene.as_path());
    let game = if opts.game.is_some_and(|s| !s.is_empty()) || info.game.is_some() {
        games::resolve_game(opts.game, Some(&info))?
    } else if let Some(d) = cached.as_ref().filter(|d| {
        d["video"]["size"].as_u64() == Some(info.size)
            && (d["video"]["mtime"].as_f64().unwrap_or(-1.) - info.mtime).abs() < 1e-6
    }) {
        d["game"].as_str().unwrap_or("apex").to_owned()
    } else {
        crate::game_detect::detect(path, &info, scene, opts.hwaccel, opts.cancel)?
    };
    games::require_analyzable(&game)?;
    if game == "valorant" {
        let (layout, source) = aspect::resolve_layout(opts.layout, &info);
        let p = crate::valorant::load_valorant_profile(&games::profile_dir_for(
            &profile.dir,
            "valorant",
        ))?
        .with_layout(layout.unwrap_or_default());
        return crate::valorant::analyze_valorant(path, &info, &p, opts, source);
    }
    let explicit = opts
        .layout
        .or_else(|| (!profile.layout.identity()).then_some(profile.layout));
    let (mut layout, mut source) = aspect::resolve_layout(explicit, &info);
    let mut p = profile.with_layout(layout.unwrap_or_default());
    let (cp, old) = cache::prepare_cache(path, opts.cache_dir, opts.beside);
    let squash = layout.map(|l| l.squash);
    if !opts.force
        && !cache::needs_reanalysis(old.as_ref(), &info, &p.templates_version, squash, "apex")
    {
        let mut doc = old.clone().unwrap();
        if layout.is_none() && doc["analysis"].get("aspect_source").is_none() {
            let d = aspect::detect_aspect(path, &info, scene, opts.hwaccel, opts.cancel)?;
            if calibrate::stopped(opts.cancel) {
                return Err(Cancelled.into());
            }
            layout = Some(d.layout);
            source = if d.found { "detected" } else { "default" };
            p = p.with_layout(d.layout);
            if doc["analysis"]["aspect_squash"].as_f64().unwrap_or(1.) == d.layout.squash {
                doc["analysis"]["aspect_source"] = source.into();
                doc["analysis"]["aspect_squash"] = d.layout.squash.into();
                save(&cp, &mut doc, opts.cache_dir)?;
                return Ok(doc);
            }
        } else {
            doc["cache_path"] = cp.to_string_lossy().as_ref().into();
            return Ok(doc);
        }
    }
    let old = old.unwrap_or(Value::Null);
    let mut resuming = !opts.force && resumable(&old, &info, &p, squash.is_some());
    let mut segs = None;
    if resuming
        && old["analysis"]["segments"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
    {
        segs = restore(&old["analysis"]["segments"], info.duration);
        resuming = segs.is_some();
    }
    let mut scale = None;
    let mut keywords = None;
    let mut done_events = vec![];
    let mut done_spec = vec![];
    let base_raw = if resuming {
        if layout.is_none() {
            let a = &old["analysis"];
            layout = Some(Layout {
                squash: a["aspect_squash"].as_f64().unwrap_or(1.),
            });
            source = a["aspect_source"].as_str().unwrap_or("default");
            p = p.with_layout(layout.unwrap());
        }
        scale = old["analysis"]["h_scale"].as_f64();
        keywords = old["analysis"]
            .get("keywords")
            .filter(|v| !v.is_null())
            .and_then(|v| Keywords::from_dict(Some(v)).ok());
        done_events = read_list(&old["events"])?;
        done_spec = read_list(&old["spectating"])?;
        if segs.is_none() {
            let mut sg = Segment::new(0., info.duration, true, info.duration);
            sg.progress = old["analysis"]["progress_t"].as_f64().unwrap_or(0.);
            sg.snap_progress = sg.progress;
            segs = Some(vec![sg]);
        }
        &old["base_events"]
    } else if old["analysis"]["status"] == "partial" {
        &old["base_events"]
    } else {
        &old["events"]
    };
    let base = read_list(base_raw)?;
    let clips = cache::merge_clips(&read_list(&old["clips"])?, &[]);
    if scale.is_none() || keywords.is_none() {
        let calibrated = (|| -> Result<f64> {
            if layout.is_none() {
                let d = aspect::detect_aspect(path, &info, scene, opts.hwaccel, opts.cancel)?;
                source = if d.found { "detected" } else { "default" };
                p = p.with_layout(d.layout);
            }
            match scale {
                Some(s) => Ok(s),
                None => calibrate::calibrate(path, &info, &p, 600., opts.cancel, opts.hwaccel),
            }
        })();
        match calibrated {
            Ok(s) => scale = Some(s),
            Err(e) => {
                if e.is::<Cancelled>() {
                    let doc = Document {
                        info: &info,
                        profile: &p,
                        scale: None,
                        source,
                        clips,
                        base,
                    };
                    save(&cp, &mut doc.partial(None), opts.cache_dir)?;
                }
                return Err(e);
            }
        }
        let jobs = opts
            .jobs
            .unwrap_or_else(|| auto_jobs(decode::is_gpu_path(Some(&info.codec), opts.hwaccel)));
        let plan = plan_segments(
            info.duration,
            jobs,
            if opts.jobs.is_some() { 5. } else { 30. },
        );
        segs = Some(
            plan.iter()
                .enumerate()
                .map(|(i, &(a, b))| Segment::new(a, b, i + 1 == plan.len(), info.duration))
                .collect(),
        );
    }
    let mut segs = segs.unwrap();
    for s in &mut segs {
        s.own_from = if s.done() { s.end } else { s.resume_plan().0 };
    }
    done_events.retain(|e: &Event| {
        segs.iter()
            .find(|s| e.t >= s.start - 1e-6 && (s.last || e.t < s.end - 1e-6))
            .is_none_or(|s| s.done() || e.t < s.own_from - 1e-6)
    });
    for s in segs.iter().filter(|s| !s.done()) {
        done_spec = cut_intervals(
            &done_spec,
            s.own_from,
            if s.last { f64::INFINITY } else { s.end },
        );
    }
    let learning = keywords
        .is_none()
        .then(|| Learning::new(&segs, info.duration));
    let doc = Document {
        info: &info,
        profile: &p,
        scale,
        source,
        clips,
        base,
    };
    let state = Mutex::new(State::new(segs, done_events, done_spec, keywords, learning));
    let abort = AtomicBool::new(false);
    let result = worker::run(path, &doc, &opts, &cp, &state, &abort);
    let mut state = state.into_inner().unwrap();
    if let Err(e) = result {
        let _ = save(&cp, &mut doc.partial(Some(&state)), opts.cache_dir);
        return Err(e);
    }
    if !state.segs.iter().all(Segment::done) {
        save(&cp, &mut doc.partial(Some(&state)), opts.cache_dir)?;
        return Err(Cancelled.into());
    }
    worker::finalize(&mut state, &p, scale.unwrap())?;
    (opts.on_progress)(info.duration, info.duration);
    let (raw, spec) = state.combined();
    let (raw, unmatched) = if doc.base.is_empty() {
        (raw, vec![])
    } else {
        cache::merge_reanalysis(&doc.base, &raw)
    };
    let final_events = derive::derive(&raw, &spec, &p);
    let mut result = doc.make(
        "done",
        info.duration,
        &final_events,
        &spec,
        None,
        state.learned(),
    );
    result["keyframes"] = json!(probe::keyframes(path).unwrap_or_default());
    result["unmatched"] = json!(unmatched);
    save(&cp, &mut result, opts.cache_dir)?;
    Ok(result)
}
