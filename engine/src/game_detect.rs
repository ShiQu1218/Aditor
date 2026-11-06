use crate::{
    aspect::{choose_layout_with_matcher, Detection, DETECT_SAMPLES, SAMPLE_DECODERS},
    cv::{self, Image},
    decode::build_input_args,
    errors::UnknownGame,
    ffbin,
    layout::{parse_aspect, SUPPORTED_ASPECTS},
    models::VideoInfo,
    process,
    scene::SceneMatcher,
};
use anyhow::Result;
use std::{
    collections::VecDeque,
    path::Path,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub const GAME_SAMPLES: usize = 24;
const GAME_BYTES: usize = 1920 * 1080 * 3;
const BOTH_BYTES: usize = 1920 * 1440 * 3;
const BOTH_FILTER: &str = "[0:v:0]split[g0][a0];\
[g0]scale=1920:1080,format=bgr24[g];\
[a0]scale=640:360,format=gray,format=bgr24,pad=1920:360[a];\
[g][a]vstack=inputs=2[out]";

pub fn scoreboard_visible(frame: &Image<u8>) -> Result<bool> {
    let hsv = cv::hsv(&frame.crop(0, 0, 1920, 80)?)?;
    let share = |x, y, w, h, ranges: &[(u8, u8)]| -> Result<f64> {
        let region = hsv.crop(x, y, w, h)?;
        Ok(region
            .data
            .as_chunks::<3>()
            .0
            .iter()
            .filter(|p| {
                p[1] >= 60 && p[2] >= 90 && ranges.iter().any(|&(lo, hi)| p[0] >= lo && p[0] <= hi)
            })
            .count() as f64
            / (w * h) as f64)
    };
    let gray = hsv
        .crop(796, 36, 56, 26)?
        .data
        .as_chunks::<3>()
        .0
        .iter()
        .map(|p| p[1] as f64)
        .sum::<f64>()
        / (56. * 26.)
        < 70.;
    Ok(gray
        && (share(712, 34, 56, 30, &[(65, 100)])? >= 0.35
            || share(1140, 34, 56, 30, &[(0, 10), (170, 180)])? >= 0.35))
}

pub fn pick_game(hits: &std::collections::BTreeMap<String, usize>) -> Option<String> {
    let a = hits.get("apex").copied().unwrap_or(0);
    let v = hits.get("valorant").copied().unwrap_or(0);
    if a >= 3 && a > v {
        Some("apex".into())
    } else if v >= 3 && v > a {
        Some("valorant".into())
    } else {
        None
    }
}
fn frame_game(frame: &Image<u8>, matcher: &SceneMatcher) -> Result<Option<&'static str>> {
    if scoreboard_visible(frame)? {
        return Ok(Some("valorant"));
    }
    let gray = cv::resize(&cv::gray(frame)?, 640, 360, cv::Interpolation::Area)?;
    for (name, _) in SUPPORTED_ASPECTS {
        if matcher.classify(&gray, parse_aspect(name)?)? != "other" {
            return Ok(Some("apex"));
        }
    }
    Ok(None)
}
pub fn count_hits(
    frames: impl IntoIterator<Item = Image<u8>>,
    scene_dir: Option<&Path>,
) -> Result<std::collections::BTreeMap<String, usize>> {
    let matcher = SceneMatcher::new(scene_dir)?;
    let mut hits = std::collections::BTreeMap::from([("apex".into(), 0), ("valorant".into(), 0)]);
    for frame in frames {
        if let Some(game) = frame_game(&frame, &matcher)? {
            *hits.get_mut(game).unwrap() += 1;
        }
    }
    Ok(hits)
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
        let out = process::read_frame(
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
                    "scale=1920:1080",
                    "-pix_fmt",
                    "bgr24",
                    "-threads",
                    "1",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                ]),
            GAME_BYTES,
            Duration::from_secs(60),
            cancel,
        );
        match out {
            Ok(Some(buf)) => return Ok(Some(Image::new(1920, 1080, 3, buf)?)),
            Err(e) if e.is::<crate::errors::Cancelled>() => return Err(e),
            _ => {}
        }
    }
    Ok(None)
}
pub fn grab_both(
    path: &str,
    t: f64,
    hwaccel: bool,
    cancel: Option<&AtomicBool>,
) -> Result<Option<(Image<u8>, Image<u8>)>> {
    for hw in if hwaccel {
        &[true, false][..]
    } else {
        &[false][..]
    } {
        let out = process::read_frame(
            Command::new(ffbin::ffmpeg()?)
                .args(["-v", "error", "-nostdin"])
                .args(build_input_args(None, *hw, t))
                .args([
                    "-i",
                    path,
                    "-filter_complex",
                    BOTH_FILTER,
                    "-map",
                    "[out]",
                    "-an",
                    "-sn",
                    "-dn",
                    "-frames:v",
                    "1",
                    "-pix_fmt",
                    "bgr24",
                    "-threads",
                    "1",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                ]),
            BOTH_BYTES,
            Duration::from_secs(60),
            cancel,
        );
        match out {
            Ok(Some(mut buf)) => {
                let mut gray = Vec::with_capacity(640 * 360);
                for row in buf[GAME_BYTES..].as_chunks::<{ 1920 * 3 }>().0 {
                    gray.extend(row[..640 * 3].iter().step_by(3).copied());
                }
                buf.truncate(GAME_BYTES);
                return Ok(Some((
                    Image::new(1920, 1080, 3, buf)?,
                    Image::new(640, 360, 1, gray)?,
                )));
            }
            Err(e) if e.is::<crate::errors::Cancelled>() => return Err(e),
            Err(e) if e.to_string() != "timed out" => return Err(e),
            _ => {}
        }
    }
    Ok(None)
}
fn seek_key(t: f64) -> Option<String> {
    (t > 0.).then(|| format!("{t:.3}"))
}
fn same_sample_times(tg: f64, ta: f64) -> bool {
    seek_key(tg) == seek_key(ta)
        && (tg > 1.) == (ta > 1.)
        && (tg <= 1. || seek_key(tg - 1.) == seek_key(ta - 1.))
}
type GameSample = (Option<Image<u8>>, Option<Image<u8>>);
enum PreludeTask<'s> {
    Game(
        Option<usize>,
        std::thread::ScopedJoinHandle<'s, Result<GameSample>>,
    ),
    Aspect(
        usize,
        std::thread::ScopedJoinHandle<'s, Result<Option<Image<u8>>>>,
    ),
}
struct Sched {
    shared_for_game: [Option<usize>; GAME_SAMPLES],
    is_shared_aspect: [bool; DETECT_SAMPLES],
    next_game: usize,
    classified: usize,
    next_aspect: usize,
    apex: usize,
    valorant: usize,
    failed: bool,
}
impl Sched {
    fn new(duration: f64) -> Self {
        let mut shared_for_game = [None; GAME_SAMPLES];
        let mut is_shared_aspect = [false; DETECT_SAMPLES];
        for k in 0..8 {
            let (gi, ai) = (3 * k + 1, 5 * k + 2);
            let tg = duration * (gi as f64 + 0.5) / GAME_SAMPLES as f64;
            let ta = duration * (ai as f64 + 0.5) / DETECT_SAMPLES as f64;
            if same_sample_times(tg, ta) {
                shared_for_game[gi] = Some(ai);
                is_shared_aspect[ai] = true;
            }
        }
        Self {
            shared_for_game,
            is_shared_aspect,
            next_game: 0,
            classified: 0,
            next_aspect: 0,
            apex: 0,
            valorant: 0,
            failed: false,
        }
    }
    fn fill<'s, 'env, FG, FA>(
        &mut self,
        scope: &'s std::thread::Scope<'s, 'env>,
        pending: &mut VecDeque<PreludeTask<'s>>,
        sample_game: &'env FG,
        sample_aspect: &'env FA,
    ) where
        FG: Fn(usize, bool) -> Result<GameSample> + Sync,
        FA: Fn(usize) -> Result<Option<Image<u8>>> + Sync,
    {
        while !self.failed && pending.len() < SAMPLE_DECODERS {
            let remaining = GAME_SAMPLES - self.classified;
            if self.next_game < GAME_SAMPLES {
                let i = self.next_game;
                self.next_game += 1;
                let valorant_clinched = self.valorant >= 3 && self.valorant > self.apex + remaining;
                let aspect_idx = if valorant_clinched {
                    None
                } else {
                    self.shared_for_game[i]
                };
                let with_aspect = aspect_idx.is_some();
                pending.push_back(PreludeTask::Game(
                    aspect_idx,
                    scope.spawn(move || sample_game(i, with_aspect)),
                ));
                continue;
            }
            if self.apex < 3 || self.apex <= self.valorant + remaining {
                break;
            }
            while self.next_aspect < DETECT_SAMPLES && self.is_shared_aspect[self.next_aspect] {
                self.next_aspect += 1;
            }
            if self.next_aspect >= DETECT_SAMPLES {
                break;
            }
            let j = self.next_aspect;
            self.next_aspect += 1;
            pending.push_back(PreludeTask::Aspect(
                j,
                scope.spawn(move || sample_aspect(j)),
            ));
        }
    }
}
fn resolve_game_votes(apex: usize, valorant: usize) -> Result<String> {
    match (apex, valorant) {
        (a, v) if a >= 3 && a > v => Ok("apex".into()),
        (a, v) if v >= 3 && v > a => Ok("valorant".into()),
        _ => Err(UnknownGame(
            "Could not recognise the game in this video; choose Apex or Valorant".into(),
        )
        .into()),
    }
}
pub(crate) fn run_prelude_samples<R>(
    duration: f64,
    cancel: Option<&AtomicBool>,
    grab_game: impl Fn(f64) -> Result<Option<Image<u8>>> + Sync,
    grab_both: impl Fn(f64) -> Result<Option<(Image<u8>, Image<u8>)>> + Sync,
    grab_aspect: impl Fn(f64) -> Result<Option<Image<u8>>> + Sync,
    mut classify_game: impl FnMut(Image<u8>) -> Result<Option<&'static str>>,
    consume_aspect: impl FnOnce(&mut dyn Iterator<Item = Result<Image<u8>>>) -> Result<R>,
) -> Result<(String, Option<Result<R>>)> {
    if duration <= 0. {
        return Ok((resolve_game_votes(0, 0)?, None));
    }
    let grab_game = &grab_game;
    let grab_both = &grab_both;
    let grab_aspect = &grab_aspect;
    let sample_game = |i: usize, with_aspect: bool| -> Result<GameSample> {
        let t = duration * (i as f64 + 0.5) / GAME_SAMPLES as f64;
        if with_aspect {
            let both = grab_both(t)?;
            let both = if both.is_none() && t > 1. {
                grab_both(t - 1.)?
            } else {
                both
            };
            Ok(match both {
                Some((g, a)) => (Some(g), Some(a)),
                None => (None, None),
            })
        } else {
            let g = grab_game(t)?;
            let g = if g.is_none() && t > 1. {
                grab_game(t - 1.)?
            } else {
                g
            };
            Ok((g, None))
        }
    };
    let sample_aspect = |j: usize| -> Result<Option<Image<u8>>> {
        let t = duration * (j as f64 + 0.5) / DETECT_SAMPLES as f64;
        let a = grab_aspect(t)?;
        if a.is_none() && t > 1. {
            grab_aspect(t - 1.)
        } else {
            Ok(a)
        }
    };
    std::thread::scope(|scope| {
        let mut s = Sched::new(duration);
        let mut pending = VecDeque::with_capacity(SAMPLE_DECODERS);
        let mut shared_frames: Vec<Option<Option<Image<u8>>>> =
            (0..DETECT_SAMPLES).map(|_| None).collect();
        s.fill(scope, &mut pending, &sample_game, &sample_aspect);
        while s.classified < GAME_SAMPLES {
            let Some(PreludeTask::Game(aspect_idx, handle)) = pending.pop_front() else {
                unreachable!("game tasks precede aspect tasks");
            };
            let result = handle
                .join()
                .unwrap_or_else(|_| Err(anyhow::anyhow!("Sample worker panicked")));
            match result {
                Ok((game_frame, aspect_frame)) => {
                    if let Some(ai) = aspect_idx {
                        shared_frames[ai] = Some(aspect_frame);
                    }
                    s.fill(scope, &mut pending, &sample_game, &sample_aspect);
                    if let Some(frame) = game_frame {
                        match classify_game(frame)? {
                            Some("valorant") => s.valorant += 1,
                            Some("apex") => s.apex += 1,
                            _ => {}
                        }
                    }
                    s.classified += 1;
                    s.fill(scope, &mut pending, &sample_game, &sample_aspect);
                }
                Err(e) => return Err(e),
            }
        }
        let game = resolve_game_votes(s.apex, s.valorant)?;
        if game != "apex" {
            return Ok((game, None));
        }
        s.fill(scope, &mut pending, &sample_game, &sample_aspect);
        let mut next_yield = 0usize;
        let mut aspect_iter = std::iter::from_fn(|| {
            while next_yield < DETECT_SAMPLES {
                s.fill(scope, &mut pending, &sample_game, &sample_aspect);
                let j = next_yield;
                next_yield += 1;
                let result = if s.is_shared_aspect[j] {
                    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                        Err(crate::errors::Cancelled.into())
                    } else {
                        Ok(shared_frames[j].take().flatten())
                    }
                } else {
                    let Some(PreludeTask::Aspect(idx, handle)) = pending.pop_front() else {
                        return None;
                    };
                    debug_assert_eq!(idx, j);
                    handle
                        .join()
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("Sample worker panicked")))
                };
                s.failed |= result.is_err();
                s.fill(scope, &mut pending, &sample_game, &sample_aspect);
                match result {
                    Ok(Some(img)) => return Some(Ok(img)),
                    Ok(None) => continue,
                    Err(e) => return Some(Err(e)),
                }
            }
            None
        });
        Ok((game, Some(consume_aspect(&mut aspect_iter))))
    })
}
pub fn detect_game_and_aspect(
    path: &str,
    info: &VideoInfo,
    scene: Option<&Path>,
    hwaccel: bool,
    cancel: Option<&AtomicBool>,
) -> Result<(String, Option<Result<Detection>>)> {
    let matcher = SceneMatcher::new(scene)?;
    run_prelude_samples(
        info.duration,
        cancel,
        |t| {
            if crate::calibrate::stopped(cancel) {
                return Err(crate::errors::Cancelled.into());
            }
            grab(path, t, hwaccel, cancel)
        },
        |t| {
            if crate::calibrate::stopped(cancel) {
                return Err(crate::errors::Cancelled.into());
            }
            grab_both(path, t, hwaccel, cancel)
        },
        |t| {
            if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                return Err(crate::errors::Cancelled.into());
            }
            crate::aspect::grab(path, t, hwaccel, cancel)
        },
        |frame| frame_game(&frame, &matcher),
        |frames| choose_layout_with_matcher(frames, &matcher),
    )
}
pub fn detect_game(
    path: &str,
    info: &VideoInfo,
    scene: Option<&Path>,
    hwaccel: bool,
    cancel: Option<&AtomicBool>,
) -> Result<Option<String>> {
    if info.duration <= 0. {
        return Ok(None);
    }
    match detect(path, info, scene, hwaccel, cancel) {
        Ok(g) => Ok(Some(g)),
        Err(e) if e.is::<UnknownGame>() => Ok(None),
        Err(e) => Err(e),
    }
}
pub fn detect(
    path: &str,
    info: &VideoInfo,
    scene: Option<&Path>,
    hwaccel: bool,
    cancel: Option<&AtomicBool>,
) -> Result<String> {
    let matcher = SceneMatcher::new(scene)?;
    let mut apex = 0;
    let mut valorant = 0;
    if info.duration > 0. {
        crate::aspect::sampled_frames(
            info.duration,
            24,
            |t| {
                if crate::calibrate::stopped(cancel) {
                    return Err(crate::errors::Cancelled.into());
                }
                grab(path, t, hwaccel, cancel)
            },
            |frames| {
                for frame in frames {
                    match frame_game(&frame?, &matcher)? {
                        Some("valorant") => valorant += 1,
                        Some("apex") => apex += 1,
                        _ => (),
                    }
                }
                Ok(())
            },
        )?;
    }
    resolve_game_votes(apex, valorant)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn prelude_reuses_coincident_samples_bounds_decoders_and_skips_non_apex() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let game_calls = AtomicUsize::new(0);
        let both_calls = AtomicUsize::new(0);
        let aspect_calls = AtomicUsize::new(0);
        let enter = || {
            let n = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(1));
            active.fetch_sub(1, Ordering::SeqCst);
        };
        let mut seen_game = Vec::new();
        let (game, aspect) = run_prelude_samples(
            240.,
            None,
            |t| {
                enter();
                game_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some(Image::new(1, 1, 1, vec![t.round() as u8])?))
            },
            |t| {
                enter();
                both_calls.fetch_add(1, Ordering::SeqCst);
                if (t - 15.).abs() < 1e-6 {
                    return Ok(None);
                }
                let b = t.round() as u8;
                Ok(Some((
                    Image::new(1, 1, 1, vec![b])?,
                    Image::new(1, 1, 1, vec![b])?,
                )))
            },
            |t| {
                enter();
                aspect_calls.fetch_add(1, Ordering::SeqCst);
                if (t - 9.).abs() < 1e-6 {
                    return Ok(None);
                }
                Ok(Some(Image::new(1, 1, 1, vec![t.round() as u8])?))
            },
            |f| {
                seen_game.push(f.data[0]);
                Ok(Some("apex"))
            },
            |frames| frames.map(|f| Ok(f?.data[0])).collect::<Result<Vec<u8>>>(),
        )
        .unwrap();
        assert_eq!(game, "apex");
        assert!((1..=SAMPLE_DECODERS).contains(&peak.load(Ordering::SeqCst)));
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(game_calls.load(Ordering::SeqCst), 16);
        assert_eq!(both_calls.load(Ordering::SeqCst), 9);
        assert_eq!(aspect_calls.load(Ordering::SeqCst), 33);
        let mut expected_game: Vec<u8> = (0..GAME_SAMPLES)
            .map(|i| (240. * (i as f64 + 0.5) / GAME_SAMPLES as f64).round() as u8)
            .collect();
        expected_game[1] -= 1;
        assert_eq!(seen_game, expected_game);
        let mut expected_aspect: Vec<u8> = (0..DETECT_SAMPLES)
            .map(|j| (240. * (j as f64 + 0.5) / DETECT_SAMPLES as f64).round() as u8)
            .collect();
        expected_aspect[1] -= 1;
        expected_aspect[2] -= 1;
        assert_eq!(aspect.unwrap().unwrap(), expected_aspect);

        let aspect_for_val = AtomicUsize::new(0);
        let (val_game, val_aspect) = run_prelude_samples(
            240.,
            None,
            |_| Ok(Some(Image::new(1, 1, 1, vec![1])?)),
            |_| {
                Ok(Some((
                    Image::new(1, 1, 1, vec![1])?,
                    Image::new(1, 1, 1, vec![1])?,
                )))
            },
            |_| {
                aspect_for_val.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            },
            |_| Ok(Some("valorant")),
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(val_game, "valorant");
        assert!(val_aspect.is_none());
        assert_eq!(aspect_for_val.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn scoreboard_requires_a_colored_strip_and_gray_score_box() {
        let mut frame = Image::new(1920, 80, 3, vec![0; 1920 * 80 * 3]).unwrap();
        assert!(!scoreboard_visible(&frame).unwrap());
        for y in 34..64 {
            for x in 712..768 {
                frame.data[(y * 1920 + x) * 3..(y * 1920 + x + 1) * 3]
                    .copy_from_slice(&[160, 220, 20]);
            }
        }
        assert!(scoreboard_visible(&frame).unwrap());
        for y in 36..62 {
            for x in 796..852 {
                frame.data[(y * 1920 + x) * 3..(y * 1920 + x + 1) * 3]
                    .copy_from_slice(&[20, 20, 220]);
            }
        }
        assert!(!scoreboard_visible(&frame).unwrap());
    }
    #[test]
    fn unknown_empty_video_and_cancellation_have_typed_errors() {
        let info = VideoInfo::default();
        assert!(detect("unused", &info, None, false, None)
            .unwrap_err()
            .is::<UnknownGame>());
        let info = VideoInfo {
            duration: 1.,
            ..info
        };
        let cancel = AtomicBool::new(true);
        assert!(detect("unused", &info, None, false, Some(&cancel))
            .unwrap_err()
            .is::<crate::errors::Cancelled>());
    }
}
