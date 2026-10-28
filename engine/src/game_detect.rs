use crate::{
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
use std::{path::Path, process::Command, sync::atomic::AtomicBool, time::Duration};

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
fn grab(
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
                    "scale=1920:1080",
                    "-pix_fmt",
                    "bgr24",
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
            Ok(o) if o.stdout.len() == 1920 * 1080 * 3 => {
                return Ok(Some(Image::new(1920, 1080, 3, o.stdout)?))
            }
            Err(e) if e.is::<crate::errors::Cancelled>() => return Err(e),
            _ => {}
        }
    }
    Ok(None)
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
        for frame in crate::aspect::sampled_frames(info.duration, 24, |t| {
            if crate::calibrate::stopped(cancel) {
                return Err(crate::errors::Cancelled.into());
            }
            grab(path, t, hwaccel, cancel)
        }) {
            match frame_game(&frame?, &matcher)? {
                Some("valorant") => valorant += 1,
                Some("apex") => apex += 1,
                _ => (),
            }
        }
    }
    match (apex, valorant) {
        (a, v) if a >= 3 && a > v => Ok("apex".into()),
        (a, v) if v >= 3 && v > a => Ok("valorant".into()),
        _ => Err(UnknownGame(
            "Could not recognise the game in this video; choose Apex or Valorant".into(),
        )
        .into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
