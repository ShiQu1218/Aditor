#![allow(dead_code)]
use aditor::{
    ffbin,
    profile::{self, Profile},
};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
pub struct TempDir(pub PathBuf);
impl TempDir {
    pub fn new() -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub fn profile() -> Profile {
    profile::load_profile(Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/icons")).unwrap()
}
#[derive(Default)]
pub struct VideoOptions<'a> {
    pub start_time: f64,
    pub vfr: bool,
    pub marks: &'a [(f64, f64)],
    pub overlay: Option<(&'a Path, &'a [(f64, f64)])>,
    pub game_height: Option<usize>,
    pub game_aspect: Option<&'a str>,
}
pub fn make_video(dir: &Path, name: &str, duration: f64, options: VideoOptions<'_>) -> PathBuf {
    let out = dir.join(name);
    let height = options.game_height.unwrap_or(1080);
    let shift = (height - 1080) / 2;
    let filters: Vec<_> = options
        .marks
        .iter()
        .map(|(a, b)| {
            format!(
                "drawbox=x=400:y={}:w=1120:h=350:color=white:t=fill:enable='between(t,{a},{b})'",
                600 + shift
            )
        })
        .collect();
    let mut chain = if filters.is_empty() {
        "null".into()
    } else {
        filters.join(",")
    };
    if options.vfr {
        chain.push_str(",select='not(eq(mod(n,7),3))',setpts='PTS+(0.006*sin(N*7))/TB'");
    }
    let mut fc = format!("[0:v]{chain}[v0]");
    let mut last = "[v0]";
    let mut cmd = Command::new(ffbin::ffmpeg().unwrap());
    cmd.args([
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        &format!("testsrc2=size=1920x{height}:rate=60:duration={duration}"),
    ]);
    if let Some((png, spans)) = options.overlay {
        cmd.args(["-loop", "1", "-i"]).arg(png);
        let en = spans
            .iter()
            .map(|(a, b)| format!("between(t,{a},{b})"))
            .collect::<Vec<_>>()
            .join("+");
        fc.push_str(&format!(
            ";[v0][1:v]overlay=x=560:y={}:enable='{en}':shortest=1[v1]",
            700 + shift
        ));
        last = "[v1]";
    }
    if height != 1080 {
        fc.push_str(&format!(";{last}scale=1920:1080[vs]"));
        last = "[vs]";
    }
    cmd.args([
        "-filter_complex",
        &fc,
        "-map",
        last,
        "-c:v",
        "libopenh264",
        "-b:v",
        "40M",
        "-allow_skip_frames",
        "0",
        "-g",
        "60",
        "-pix_fmt",
        "yuv420p",
    ]);
    if options.vfr {
        cmd.args(["-fps_mode", "passthrough"]);
    }
    if options.start_time != 0. {
        cmd.args(["-output_ts_offset", &options.start_time.to_string()]);
    }
    if let Some(aspect) = options.game_aspect {
        cmd.args([
            "-metadata",
            &format!("aditor_game_aspect={aspect}"),
            "-movflags",
            "+use_metadata_tags",
        ]);
    }
    let output = cmd
        .args(["-t", &duration.to_string()])
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    out
}
