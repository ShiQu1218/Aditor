//! Hidden evaluation commands; not part of the application protocol.
use crate::{cli::Command, decode::DecodeOptions};
use anyhow::{ensure, Result};
use serde_json::json;
use std::{path::Path, time::Instant};

pub fn run(cmd: &Command) -> Result<()> {
    let value = |key: &str| cmd.options.get(key).and_then(|v| v.as_deref());
    let video = cmd.video.as_deref().unwrap();
    let dir = Path::new(value("--profile-dir").unwrap());
    if cmd.name == "debug-valorant-feed" {
        // Same layout and capture crops as valorant::analyze_valorant, so 4:3/16:10 recordings decode identically.
        let info = crate::probe::probe(video)?;
        let (layout, _) = crate::aspect::resolve_layout(None, &info);
        let p =
            crate::valorant::load_valorant_profile(dir)?.with_layout(layout.unwrap_or_default());
        let detector = crate::valorant::FeedDetector::new(&p);
        let mut tracker = crate::valorant::FeedTracker::default();
        let stream = crate::decode::FrameStream::for_capture(
            video,
            p.decoder_profile(),
            DecodeOptions {
                hwaccel: false,
                ..Default::default()
            },
            p.capture_banner,
            p.capture_spec,
        );
        for frame in stream {
            let (t, b, s) = frame?;
            let (b, _) = p.restore(&b, &s)?;
            let rows = detector.observations(&b)?;
            tracker.feed(t, &rows);
            println!(
                "{}",
                json!({"t":t,"observations":rows.iter().map(|r| json!({"slot":r.slot,"kind":r.kind,"confirmed":r.confirmed})).collect::<Vec<_>>(),"events":tracker.events})
            );
        }
        return Ok(());
    }
    let start: f64 = value("--start").unwrap_or("0").parse()?;
    let seconds: Option<f64> = value("--seconds").map(str::parse).transpose()?;
    ensure!(
        start.is_finite() && start >= 0. && seconds.is_none_or(|s| s.is_finite() && s > 0.),
        "start must be nonnegative and seconds positive and finite"
    );
    let p = crate::profile::load_profile(dir)?;
    let detector = if cmd.options.contains_key("--decode-only") {
        None
    } else {
        Some(crate::detect::Detector::new(&p, 1., None, None)?)
    };
    let info = crate::probe::probe(video)?;
    let hwaccel = !cmd.options.contains_key("--no-hwaccel");
    let mut stream = crate::decode::FrameStream::new(
        video,
        p,
        DecodeOptions {
            start,
            end: seconds.map(|s| start + s),
            hwaccel,
            codec: Some(info.codec),
        },
    );
    let clock = Instant::now();
    let mut startup = None;
    let mut frames = 0;
    let mut last = start;
    let mut detection_s = 0.;
    for frame in stream.by_ref() {
        let (t, b, s) = frame?;
        startup.get_or_insert_with(|| clock.elapsed().as_secs_f64());
        if let Some(detector) = &detector {
            let detect_start = Instant::now();
            detector.detect(&b, &s)?;
            detection_s += detect_start.elapsed().as_secs_f64();
        }
        frames += 1;
        last = t;
    }
    let wall_s = clock.elapsed().as_secs_f64();
    let video_s = if frames == 0 { 0. } else { last - start + 0.25 };
    println!(
        "{}",
        json!({"hwaccel":hwaccel,"used_hwaccel":stream.used_hwaccel,"frames":frames,"video_s":video_s,"wall_s":wall_s,"startup_s":startup.unwrap_or(0.),"detection_s":detection_s,"speed":video_s/wall_s})
    );
    Ok(())
}
