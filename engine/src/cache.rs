use crate::models::{Clip, Event, VideoInfo};
use anyhow::Result;
use serde_json::Value;
use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
};
pub const ENGINE_VERSION: &str = "0.3.0";
fn normalize(path: &str) -> String {
    let path = std::path::absolute(path).unwrap_or_else(|_| PathBuf::from(path));
    let mut parts = Vec::new();
    for c in path.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if parts.last().is_some_and(|p: &std::ffi::OsString| {
                    Path::new(p)
                        .components()
                        .all(|c| matches!(c, std::path::Component::Normal(_)))
                }) {
                    parts.pop();
                }
            }
            _ => parts.push(c.as_os_str().to_owned()),
        }
    }
    parts
        .iter()
        .collect::<PathBuf>()
        .to_string_lossy()
        .to_lowercase()
        .replace('\\', "/")
}
fn sha1(input: &[u8]) -> String {
    let mut data = input.to_vec();
    let bits = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bits.to_be_bytes());
    let mut h = [
        0x67452301u32,
        0xefcdab89,
        0x98badcfe,
        0x10325476,
        0xc3d2e1f0,
    ];
    for chunk in data.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, b) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes(b.try_into().unwrap());
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, &word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (h, v) in h.iter_mut().zip([a, b, c, d, e]) {
            *h = h.wrapping_add(v);
        }
    }
    h.iter().map(|n| format!("{n:08x}")).collect()
}
pub fn cache_path(video: &str, dir: &Path, beside: bool) -> PathBuf {
    let path = Path::new(video);
    if beside {
        path.with_file_name(format!(
            "{}.aditor.json",
            path.file_name().unwrap_or_default().to_string_lossy()
        ))
    } else {
        dir.join(format!("{}.json", sha1(normalize(video).as_bytes())))
    }
}
pub fn legacy_cache_path(video: &str, dir: &Path, beside: bool) -> PathBuf {
    if !beside {
        return cache_path(video, dir, false);
    }
    let path = Path::new(video);
    path.with_file_name(format!(
        "{}.aditor.json",
        path.file_stem().unwrap_or_default().to_string_lossy()
    ))
}
fn belongs(doc: &Value, video: &str) -> bool {
    doc["video"]["path"]
        .as_str()
        .is_some_and(|p| normalize(p) == normalize(video))
}
pub fn load_cache(path: &Path) -> Option<Value> {
    serde_json::from_slice::<Value>(&std::fs::read(path).ok()?)
        .ok()
        .filter(Value::is_object)
}
pub fn resolve_cache_path(video: &str, dir: &Path, beside: bool) -> PathBuf {
    let preferred = cache_path(video, dir, beside);
    let legacy = legacy_cache_path(video, dir, true);
    let other = cache_path(video, dir, !beside);
    let candidates = if beside {
        vec![(preferred.clone(), false), (legacy, true), (other, false)]
    } else {
        vec![(preferred.clone(), false), (other, false), (legacy, true)]
    };
    let valid: Vec<_> = candidates
        .into_iter()
        .enumerate()
        .filter_map(|(i, (p, old))| {
            load_cache(&p)
                .filter(|d| !old || belongs(d, video))
                .map(|d| (i, p, d))
        })
        .collect();
    valid
        .iter()
        .filter(|(_, _, d)| belongs(d, video))
        .max_by_key(|(i, p, _)| {
            (
                std::fs::metadata(p).and_then(|m| m.modified()).ok(),
                std::cmp::Reverse(*i),
            )
        })
        .or_else(|| valid.first())
        .map_or(preferred, |(_, p, _)| p.clone())
}
pub fn prepare_cache(video: &str, dir: &Path, beside: bool) -> (PathBuf, Option<Value>) {
    let mut target = cache_path(video, dir, beside);
    let source = resolve_cache_path(video, dir, beside);
    let mut old = load_cache(&source);
    if source != target {
        if let Some(doc) = &old {
            let mut migrated = doc.clone();
            migrated["cache_path"] = target.to_string_lossy().as_ref().into();
            if let Ok(written) = save_cache(&target, &migrated, Some(dir)) {
                target = written;
                migrated["cache_path"] = target.to_string_lossy().as_ref().into();
                old = Some(migrated);
            }
        }
    }
    (target, old)
}
struct PythonFormatter;
impl serde_json::ser::Formatter for PythonFormatter {
    fn write_f64<W: ?Sized + Write>(&mut self, w: &mut W, value: f64) -> std::io::Result<()> {
        let text = format!("{value:?}");
        if let Some((mantissa, exponent)) = text.split_once('e') {
            let exponent: i32 = exponent.parse().unwrap();
            write!(w, "{mantissa}e{exponent:+03}")
        } else {
            w.write_all(text.as_bytes())
        }
    }
    fn begin_array_value<W: ?Sized + Write>(
        &mut self,
        w: &mut W,
        first: bool,
    ) -> std::io::Result<()> {
        if first {
            Ok(())
        } else {
            w.write_all(b", ")
        }
    }
    fn begin_object_key<W: ?Sized + Write>(
        &mut self,
        w: &mut W,
        first: bool,
    ) -> std::io::Result<()> {
        if first {
            Ok(())
        } else {
            w.write_all(b", ")
        }
    }
    fn begin_object_value<W: ?Sized + Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        w.write_all(b": ")
    }
}
pub fn json_bytes(doc: &Value) -> Result<Vec<u8>> {
    use serde::Serialize;
    let mut bytes = vec![];
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, PythonFormatter);
    doc.serialize(&mut serializer)?;
    Ok(bytes)
}
fn write(path: &Path, doc: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().unwrap_or_default().to_string_lossy()
    ));
    std::fs::write(&tmp, json_bytes(doc)?)?;
    // Windows rename does not replace existing files; MoveFileExW preserves atomic replacement.
    replace(&tmp, path)?;
    Ok(())
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
pub fn save_cache(path: &Path, doc: &Value, fallback: Option<&Path>) -> Result<PathBuf> {
    match write(path, doc) {
        Ok(()) => return Ok(path.into()),
        Err(e) if fallback.is_none() => return Err(e),
        _ => {}
    }
    let dir = fallback.unwrap();
    let fb = doc["video"]["path"].as_str().map_or_else(
        || dir.join(path.file_name().unwrap_or_default()),
        |p| cache_path(p, dir, false),
    );
    write(&fb, doc)?;
    Ok(fb)
}
pub fn needs_reanalysis(
    doc: Option<&Value>,
    info: &VideoInfo,
    templates: &str,
    squash: Option<f64>,
    game: &str,
) -> bool {
    let Some(doc) = doc else {
        return true;
    };
    let a = &doc["analysis"];
    let v = &doc["video"];
    a["status"] != "done"
        || v["size"].as_u64() != Some(info.size)
        || (v["mtime"].as_f64().unwrap_or(-1.) - info.mtime).abs() >= 1e-6
        || a["engine_version"] != ENGINE_VERSION
        || squash.is_some_and(|s| a["aspect_squash"].as_f64().unwrap_or(1.) != s)
        || doc["game"].as_str().unwrap_or("apex") != game
        || a["templates_version"] != templates
}
fn family(kind: &str) -> &str {
    match kind {
        "assist_knock" | "assist_elim" => "assist",
        "multikill" | "ace" => "highlight",
        _ => kind,
    }
}
pub fn merge_reanalysis(old: &[Event], auto: &[Event]) -> (Vec<Event>, Vec<Event>) {
    let mut new = auto.to_vec();
    let mut received = HashSet::new();
    let mut unmatched = vec![];
    let mut olds: Vec<_> = old
        .iter()
        .filter(|e| e.source != "manual" && (e.deleted || e.counted_override.is_some()))
        .collect();
    olds.sort_by(|a, b| a.t.total_cmp(&b.t));
    let mut pending = vec![];
    for o in olds {
        if let Some(i) = new
            .iter()
            .enumerate()
            .position(|(i, e)| !received.contains(&i) && e.id == o.id)
        {
            received.insert(i);
            new[i].deleted = o.deleted;
            new[i].counted_override = o.counted_override;
        } else {
            pending.push(o);
        }
    }
    for o in pending {
        let best = new
            .iter()
            .enumerate()
            .filter(|(i, e)| {
                !received.contains(i)
                    && family(&e.kind) == family(&o.kind)
                    && (e.t - o.t).abs() <= 1.
            })
            .min_by(|(ia, a), (ib, b)| {
                (a.t - o.t)
                    .abs()
                    .total_cmp(&(b.t - o.t).abs())
                    .then(ia.cmp(ib))
            })
            .map(|(i, _)| i);
        if let Some(i) = best {
            received.insert(i);
            new[i].deleted = o.deleted;
            new[i].counted_override = o.counted_override;
        } else {
            unmatched.push(o.clone());
        }
    }
    let mut merged: Vec<_> = old
        .iter()
        .filter(|e| e.source == "manual")
        .cloned()
        .chain(new)
        .collect();
    merged.sort_by(|a, b| a.t.total_cmp(&b.t));
    (merged, unmatched)
}
pub fn merge_clips(old: &[Clip], new: &[Clip]) -> Vec<Clip> {
    let mut clips: Vec<_> = old
        .iter()
        .filter(|c| c.origin == "manual")
        .chain(new)
        .cloned()
        .collect();
    clips.sort_by(|a, b| a.start.total_cmp(&b.start));
    clips
}

#[cfg(test)]
mod tests {
    #[test]
    fn sha1_vectors() {
        assert_eq!(super::sha1(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            super::sha1(b"abc"),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
    }
}
