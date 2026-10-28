use crate::{
    cv::{self, Image, Interpolation},
    decode::build_input_args,
    ffbin,
    layout::{self, Layout},
    models::VideoInfo,
    process,
    scene::SceneMatcher,
};
use anyhow::{bail, Result};
use std::{
    collections::BTreeMap,
    path::Path,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
pub const DETECT_SAMPLES: usize = 40;
pub const MIN_POSITIVE_FRAMES: usize = 3;
pub const DEFAULT_ASPECT: &str = "16:9";
pub type AspectStats = Vec<(String, (usize, f64))>;
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Detection {
    pub layout: Layout,
    pub found: bool,
}
pub fn resolve_layout(
    explicit: Option<Layout>,
    info: &VideoInfo,
) -> (Option<Layout>, &'static str) {
    if explicit.is_some() {
        (explicit, "explicit")
    } else if let Some(tag) = layout::tagged_layout(info.game_aspect.as_deref()) {
        (Some(tag), "tag")
    } else {
        (None, "default")
    }
}
pub fn pick_aspect(stats: &[(String, (usize, f64))]) -> Option<String> {
    let best = stats.iter().map(|(_, s)| s.0).max().unwrap_or(0);
    if best < MIN_POSITIVE_FRAMES {
        return None;
    }
    if stats
        .iter()
        .any(|(n, s)| n == DEFAULT_ASPECT && s.0 == best)
    {
        return Some(DEFAULT_ASPECT.into());
    }
    let mut winner = None;
    let mut score = f64::NEG_INFINITY;
    for (n, (count, total)) in stats {
        if *count == best && (winner.is_none() || *total > score) {
            winner = Some(n.clone());
            score = *total;
        }
    }
    winner
}
pub fn template_score(s: &BTreeMap<String, f64>) -> f64 {
    if s.is_empty() {
        return 0.;
    }
    let v = |k: &str| s.get(k).copied().unwrap_or(0.);
    let footer = v("loading_footer").max(v("wildcard_footer"));
    let minimap = v("minimap_border")
        .max(v("ranked_minimap"))
        .max(v("spectator_minimap"))
        .max(v("control_objectives"));
    let health = v("health_border")
        .max(v("ranked_health"))
        .max(v("spectator_health"));
    let chevron = v("mode_chevron").max(v("ranked_chevron"));
    chevron
        .min(footer)
        .max(v("ready_border").min(v("mode_border")))
        .max(minimap.min(health))
}
pub fn choose_layout(
    frames: impl IntoIterator<Item = Image<u8>>,
    scene_dir: Option<&Path>,
) -> Result<Detection> {
    choose_layout_results(frames.into_iter().map(Ok), scene_dir)
}
fn choose_layout_results(
    frames: impl IntoIterator<Item = Result<Image<u8>>>,
    scene_dir: Option<&Path>,
) -> Result<Detection> {
    let matcher = SceneMatcher::new(scene_dir)?;
    let mut stats: AspectStats = layout::SUPPORTED_ASPECTS
        .iter()
        .map(|(n, _)| (n.to_string(), (0, 0.)))
        .collect();
    for frame in frames {
        let frame = frame?;
        if frame.channels != 1 && frame.channels != 3 {
            bail!("Scene frame must have three BGR channels");
        }
        if frame.width < 640 || frame.height < 360 {
            bail!("Current scene settings require at least 640×360; provide a scene ROI or a larger full frame");
        }
        let gray = if frame.channels == 3 {
            cv::gray(&frame)?
        } else {
            frame
        };
        let gray = cv::resize(&gray, 640, 360, Interpolation::Area)?;
        for (name, (count, total)) in &mut stats {
            let image = layout::parse_aspect(name)?.reference_thumb(&gray)?;
            let scores = matcher.scores(&image)?;
            let v = |k: &str| scores[k];
            let positive = (v("mode_chevron").max(v("ranked_chevron")) >= 0.75
                && v("loading_footer").max(v("wildcard_footer")) >= 0.75)
                || (v("ready_border") >= 0.70 && v("mode_border") >= 0.70)
                || ((v("minimap_border")
                    .max(v("ranked_minimap"))
                    .max(v("spectator_minimap"))
                    >= 0.60
                    || v("control_objectives") >= 0.80)
                    && v("health_border")
                        .max(v("ranked_health"))
                        .max(v("spectator_health"))
                        >= 0.60);
            *count += usize::from(positive);
            *total += template_score(&scores);
        }
    }
    Ok(match pick_aspect(&stats) {
        Some(name) => Detection {
            layout: layout::parse_aspect(&name)?,
            found: true,
        },
        None => Detection {
            layout: Layout::default(),
            found: false,
        },
    })
}
pub fn grab(
    path: &str,
    t: f64,
    hwaccel: bool,
    cancel: Option<&AtomicBool>,
) -> Result<Option<Image<u8>>> {
    for hw in if hwaccel {
        &[true, false][..]
    } else {
        &[false][..]
    } {
        let out = process::output(
            Command::new(ffbin::ffmpeg()?)
                .args(["-v", "error", "-nostdin"])
                .args(build_input_args(None, *hw, t))
                .args([
                    "-i",
                    path,
                    "-map",
                    "0:v:0",
                    "-an",
                    "-sn",
                    "-dn",
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=640:360",
                    "-pix_fmt",
                    "gray",
                    "-threads",
                    "1",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                ]),
            Duration::from_secs(60),
            cancel,
        );
        match out {
            Ok(out) if out.status.success() && out.stdout.len() == 640 * 360 => {
                return Ok(Some(Image::new(640, 360, 1, out.stdout)?))
            }
            Err(e) if e.is::<crate::errors::Cancelled>() => return Err(e),
            Err(e) if e.to_string() != "timed out" => return Err(e),
            _ => {}
        }
    }
    Ok(None)
}
pub(crate) fn sampled_frames(
    duration: f64,
    samples: usize,
    grab: impl Fn(f64) -> Result<Option<Image<u8>>> + Sync,
) -> impl Iterator<Item = Result<Image<u8>>> {
    // Bound decoder memory while retaining the original sample order and retry positions.
    (0..samples)
        .step_by(4)
        .flat_map(move |start| {
            std::thread::scope(|scope| {
                let handles: Vec<_> = (start..(start + 4).min(samples))
                    .map(|i| {
                        let grab = &grab;
                        scope.spawn(move || {
                            let t = duration * (i as f64 + 0.5) / samples as f64;
                            let frame = grab(t)?;
                            if frame.is_none() && t > 1. {
                                grab(t - 1.)
                            } else {
                                Ok(frame)
                            }
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|h| {
                        h.join()
                            .unwrap_or_else(|_| Err(anyhow::anyhow!("Sample worker panicked")))
                    })
                    .collect::<Vec<_>>()
            })
        })
        .filter_map(Result::transpose)
}
pub fn detect_aspect(
    path: &str,
    info: &VideoInfo,
    scene_dir: Option<&Path>,
    hwaccel: bool,
    cancel: Option<&AtomicBool>,
) -> Result<Detection> {
    if info.duration <= 0. {
        return Ok(Detection {
            layout: Layout::default(),
            found: false,
        });
    }
    let frames = sampled_frames(info.duration, DETECT_SAMPLES, |t| {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(crate::errors::Cancelled.into());
        }
        grab(path, t, hwaccel, cancel)
    });
    choose_layout_results(frames, scene_dir)
}
pub fn detect_layout(
    path: &str,
    info: &VideoInfo,
    hwaccel: bool,
    cancel: Option<&AtomicBool>,
) -> Result<Layout> {
    Ok(detect_aspect(path, info, None, hwaccel, cancel)?.layout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn parallel_samples_preserve_order_retries_and_bound_decoders() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let frames = sampled_frames(18., 9, |t| {
            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(count, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(if t == 1. { 5 } else { 1 }));
            active.fetch_sub(1, Ordering::SeqCst);
            if [3., 4., 5.].contains(&t) {
                Ok(None)
            } else {
                Ok(Some(Image::new(1, 1, 1, vec![t as u8])?))
            }
        })
        .collect::<Result<Vec<_>>>()
        .unwrap();
        assert_eq!(
            frames.iter().map(|f| f.data[0]).collect::<Vec<_>>(),
            vec![1, 2, 7, 9, 11, 13, 15, 17]
        );
        assert!((1..=4).contains(&peak.load(Ordering::SeqCst)));
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn sample_error_stops_before_starting_the_next_batch() {
        let mut frames = sampled_frames(18., 9, |t| {
            assert!(t <= 7.);
            if t == 3. {
                bail!("sample failed");
            }
            Ok(Some(Image::new(1, 1, 1, vec![t as u8])?))
        });
        assert_eq!(frames.next().unwrap().unwrap().data, vec![1]);
        assert_eq!(
            frames.next().unwrap().unwrap_err().to_string(),
            "sample failed"
        );
    }
}
