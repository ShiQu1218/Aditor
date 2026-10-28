pub use crate::errors::ProbeError;
use crate::{ffbin, models::VideoInfo, process};
use anyhow::{bail, Result};
use serde_json::Value;
use std::{
    path::Path,
    process::Command,
    time::{Duration, UNIX_EPOCH},
};
pub fn is_16x9(w: i32, h: i32) -> bool {
    h > 0 && ((w as f64 / h as f64 - 16. / 9.) / (16. / 9.)).abs() <= 0.01
}
pub fn rate(value: Option<&Value>) -> f64 {
    let Some(s) = value.and_then(Value::as_str) else {
        return 0.;
    };
    let (num, den) = s.split_once('/').unwrap_or((s, "1"));
    let (Ok(n), Ok(d)) = (
        num.parse::<f64>(),
        if den.is_empty() {
            Ok(1.)
        } else {
            den.parse::<f64>()
        },
    ) else {
        return 0.;
    };
    if n > 0. && d > 0. {
        n / d
    } else {
        0.
    }
}
pub fn frame_rate(stream: &Value) -> f64 {
    let avg = rate(stream.get("avg_frame_rate"));
    if avg != 0. {
        avg
    } else {
        rate(stream.get("r_frame_rate"))
    }
}
fn run(args: &[&str]) -> Result<Value> {
    let output = process::output(
        Command::new(ffbin::ffprobe()?)
            .args(["-v", "error", "-of", "json"])
            .args(args),
        Duration::from_secs(120),
        None,
    )
    .map_err(|e| {
        if e.to_string() == "timed out" {
            anyhow::anyhow!("ffprobe timed out")
        } else {
            e
        }
    })?;
    if !output.status.success() {
        let tail = process::tail(&output.stderr, 500);
        bail!(
            "{}",
            if tail.is_empty() {
                "ffprobe failed"
            } else {
                &tail
            }
        );
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| anyhow::anyhow!("Could not parse ffprobe output"))
}
pub fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}
pub fn from_document(path: &str, doc: &Value) -> Result<VideoInfo> {
    (|| {

    let s = doc["streams"]
        .as_array()
        .and_then(|s| s.first())
        .ok_or_else(|| anyhow::anyhow!("No video stream found"))?;
    let fmt = &doc["format"];
    let field = |k: &str| -> Result<i32> {
        s[k].as_i64()
            .map(|v| v as i32)
            .ok_or_else(|| anyhow::anyhow!("Missing ffprobe field: KeyError('{k}')"))
    };
    let duration=number(&fmt["duration"]).ok_or_else(||anyhow::anyhow!("Missing ffprobe field: TypeError(\"float() argument must be a string or a real number, not 'NoneType'\")"))?;
    let start_time = number(&s["start_time"])
        .or_else(|| number(&fmt["start_time"]))
        .unwrap_or(0.);
    let st = std::fs::metadata(path)?;
    let tags = fmt["tags"].as_object();
    let tag = |name: &str| {
        tags.and_then(|t| {
            t.iter().find_map(|(k, v)| {
                if k.to_lowercase() == name {
                    v.as_str().map(str::to_owned)
                } else {
                    None
                }
            })
        })
    };
    Ok(VideoInfo {
        path: path.into(),
        duration,
        width: field("width")?,
        height: field("height")?,
        codec: s["codec_name"].as_str().unwrap_or("").into(),
        start_time,
        size: st.len(),
        mtime: st.modified()?.duration_since(UNIX_EPOCH)?.as_secs_f64(),
        fps: frame_rate(s),
        pix_fmt: s["pix_fmt"].as_str().unwrap_or("").into(),
        game_aspect: tag("aditor_game_aspect"),
        game: tag("aditor_game"),
    })

})().map_err(|error: anyhow::Error| anyhow::Error::new(ProbeError(error.to_string())))
}
pub fn probe(path: impl AsRef<Path>) -> Result<VideoInfo> {
    (|| {

    let path = path.as_ref().to_string_lossy();
    let doc=run(&["-select_streams","v:0","-show_entries","stream=codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,start_time:format=duration,start_time:format_tags",&path])?;
    from_document(&path, &doc)

})().map_err(|error: anyhow::Error| anyhow::Error::new(ProbeError(error.to_string())))
}
pub fn keyframes(path: impl AsRef<Path>) -> Result<Vec<f64>> {
    (|| {
        let path = path.as_ref().to_string_lossy();
        let doc = run(&["-show_entries", "format=start_time", &path])?;
        let start = number(&doc["format"]["start_time"]).unwrap_or(0.);
        let out = process::output(
            Command::new(ffbin::ffprobe()?).args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "packet=pts_time,flags",
                "-of",
                "csv=p=0",
                &path,
            ]),
            Duration::from_secs(600),
            None,
        )
        .map_err(|e| {
            if e.to_string() == "timed out" {
                anyhow::anyhow!("ffprobe timed out")
            } else {
                e
            }
        })?;
        if !out.status.success() {
            let tail = process::tail(&out.stderr, 500);
            bail!(
                "{}",
                if tail.is_empty() {
                    "ffprobe failed"
                } else {
                    &tail
                }
            );
        }
        let mut times = Vec::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some((ts, flags)) = line.trim().split_once(',') {
                if flags.contains('K') {
                    if let Ok(t) = ts.parse::<f64>() {
                        times.push(((t - start) * 1000.).round_ties_even() / 1000.);
                    }
                }
            }
        }
        times.sort_by(f64::total_cmp);
        Ok(times)
    })()
    .map_err(|error: anyhow::Error| anyhow::Error::new(ProbeError(error.to_string())))
}
