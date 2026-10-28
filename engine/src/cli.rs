use anyhow::{bail, Result};
use std::collections::BTreeMap;
pub const ANALYZE_USAGE: &str = "usage: aditor analyze [-h] --profile-dir PROFILE_DIR --cache-dir CACHE_DIR\n                      [--force] [--no-hwaccel] [--jobs JOBS] [--out OUT]\n                      [--aspect ASPECT] [--game GAME]\n                      video";
pub const ANALYZE_HELP: &str = "\npositional arguments:\n  video\n\noptions:\n  -h, --help            show this help message and exit\n  --profile-dir PROFILE_DIR\n  --cache-dir CACHE_DIR\n  --force\n  --no-hwaccel\n  --jobs JOBS           Number of segments to decode in parallel (automatic by\n                        default)\n  --out OUT\n  --aspect ASPECT       Game render aspect or resolution (16:9, 16:10, 4:3,\n                        5:4, or WxH); offline default: video metadata,\n                        otherwise 16:9\n  --game GAME           Game: apex or valorant (default: the video's\n                        aditor_game tag, otherwise apex)";

#[derive(Debug, PartialEq)]
pub struct Command {
    pub name: String,
    pub video: Option<String>,
    pub options: BTreeMap<String, Option<String>>,
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Option<Command>> {
    let mut args = args.into_iter();
    let name = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("a subcommand is required"))?;
    if name == "--help" || name == "-h" {
        return Ok(None);
    }
    let (values, flags, required): (&[&str], &[&str], &[&str]) = match name.as_str() {
        "analyze" => (
            &[
                "--profile-dir",
                "--cache-dir",
                "--jobs",
                "--out",
                "--aspect",
                "--game",
            ],
            &["--force", "--no-hwaccel"],
            &["--profile-dir", "--cache-dir"],
        ),
        "matches" => (
            &["--fps", "--aspect", "--scene-dir"],
            &["--timeline", "--no-hwaccel"],
            &[],
        ),
        "live" => (
            &[
                "--shm",
                "--profile-dir",
                "--scene-dir",
                "--aspect",
                "--game",
            ],
            &[],
            &["--shm", "--profile-dir"],
        ),
        "debug-valorant-feed" => (&["--profile-dir"], &[], &["--profile-dir"]),
        "debug-benchmark" => (
            &["--profile-dir", "--start", "--seconds"],
            &["--no-hwaccel", "--decode-only"],
            &["--profile-dir"],
        ),
        "ipc" => (&[], &[], &[]),
        _ => bail!("invalid choice: {name}"),
    };
    let mut cmd = Command {
        name,
        video: None,
        options: BTreeMap::new(),
    };
    let mut positional = false;
    while let Some(arg) = args.next() {
        if !positional && (arg == "--help" || arg == "-h") {
            return Ok(None);
        }
        if !positional && arg == "--" {
            positional = true;
            continue;
        }
        let (key, inline) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(k, v)| (k, Some(v.to_owned())));
        if !positional && values.contains(&key) {
            let value = inline
                .or_else(|| args.next())
                .ok_or_else(|| anyhow::anyhow!("argument {key}: expected one argument"))?;
            if value.starts_with("--") || value == "-h" {
                bail!("argument {key}: expected one argument");
            }
            if key == "--jobs" && value.parse::<i64>().is_err() {
                bail!(
                    "argument --jobs: invalid int value: {}",
                    crate::profile::py_repr(&value.into())
                );
            }
            if key == "--fps" && value.parse::<f64>().is_err() {
                bail!(
                    "argument --fps: invalid float value: {}",
                    crate::profile::py_repr(&value.into())
                );
            }
            cmd.options.insert(key.to_owned(), Some(value));
        } else if !positional && flags.contains(&key) && inline.is_none() {
            cmd.options.insert(arg, None);
        } else if (!arg.starts_with('-') || positional)
            && matches!(
                cmd.name.as_str(),
                "analyze" | "matches" | "debug-valorant-feed" | "debug-benchmark"
            )
            && cmd.video.is_none()
        {
            cmd.video = Some(arg);
        } else {
            bail!("unrecognized arguments: {arg}");
        }
    }
    let mut missing = Vec::new();
    if matches!(
        cmd.name.as_str(),
        "analyze" | "matches" | "debug-valorant-feed" | "debug-benchmark"
    ) && cmd.video.is_none()
    {
        missing.push("video");
    }
    for key in required {
        if !cmd.options.contains_key(*key) {
            missing.push(key);
        }
    }
    if !missing.is_empty() {
        bail!(
            "the following arguments are required: {}",
            missing.join(", ")
        );
    }
    Ok(Some(cmd))
}

pub const MATCHES_HELP: &str = include_str!("cli/matches_help.txt");
pub const LIVE_HELP: &str = include_str!("cli/live_help.txt");

pub fn usage(command: &str) -> &str {
    match command {
        "matches" => MATCHES_HELP.split("\n\n").next().unwrap(),
        "live" => LIVE_HELP.split("\n\n").next().unwrap(),
        _ => ANALYZE_USAGE,
    }
}
