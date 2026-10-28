use anyhow::{bail, Result};
use std::{
    env,
    path::{Path, PathBuf},
};
pub fn find(env_var: &str, exe: &str, bundled: &Path) -> Result<PathBuf> {
    if let Some(value) = env::var_os(env_var).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(&value);
        if path.exists() {
            return Ok(path);
        }
        bail!("{exe} not found: {env_var}={}", value.to_string_lossy());
    }
    let name = if cfg!(windows) {
        format!("{exe}.exe")
    } else {
        exe.into()
    };
    if let Some(value) = env::var_os("ADITOR_FFMPEG").filter(|v| !v.is_empty()) {
        let sibling = Path::new(&value)
            .parent()
            .unwrap_or(Path::new(""))
            .join(&name);
        if sibling.exists() {
            return Ok(sibling);
        }
    }
    for dir in [bundled.to_owned(), bundled.join("bin")] {
        let candidate = dir.join(&name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            let candidate = dir.join(&name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    bail!("{exe} not found (set {env_var}, place in ffmpeg/ or add to PATH)")
}
pub fn ffmpeg() -> Result<PathBuf> {
    find(
        "ADITOR_FFMPEG",
        "ffmpeg",
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("ffmpeg"),
    )
}
pub fn ffprobe() -> Result<PathBuf> {
    find(
        "ADITOR_FFPROBE",
        "ffprobe",
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("ffmpeg"),
    )
}
