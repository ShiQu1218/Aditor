//! Writes `index.jsonl` and `session.json` (task B4, spec §2.1).
//! One line per segment `{"seq":1,"pts":0.0,"dur":2.0,"bytes":123,"wall":"2026-10-18T21:03:05.123+08:00"}`；
//! Call `sync_data` after every line so complete lines survive a crash (readers ignore an incomplete final line).

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
use windows::Win32::System::Time::{
    FileTimeToSystemTime, GetDynamicTimeZoneInformation, SystemTimeToFileTime,
    SystemTimeToTzSpecificLocalTime, SystemTimeToTzSpecificLocalTimeEx,
    DYNAMIC_TIME_ZONE_INFORMATION, TIME_ZONE_ID_INVALID, TIME_ZONE_INFORMATION,
};

use crate::encode::SegmentInfo;
use crate::types::Codec;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexLine {
    pub seq: u64,
    pub pts: f64,
    pub dur: f64,
    pub bytes: u64,
    pub wall: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub session_id: String,
    /// ISO 8601 with timezone; set at job startup and unaffected by reopening the index.
    pub started_at: String,
    pub encoder: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Codec,
    pub audio: bool,
    pub aditorrec_version: String,
}

pub struct IndexWriter {
    file: File,
    failed: bool,
}

impl IndexWriter {
    /// Keep existing complete lines, repair an incomplete trailing line left by a crash, then resume appending.
    pub fn create(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir).context("Failed to create recording index directory")?;
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(dir.join("index.jsonl"))
            .context("Failed to open recording index")?;
        repair_tail(&mut file)?;
        file.seek(SeekFrom::End(0))
            .context("Failed to seek to the index append position")?;
        Ok(Self {
            file,
            failed: false,
        })
    }

    /// The caller must flush and sync the segment file before publishing the index entry.
    pub fn append(&mut self, segment: &SegmentInfo, wall: SystemTime) -> Result<()> {
        if self.failed {
            bail!("A previous index write failed; reopen the index before continuing");
        }
        if segment.seq == 0
            || !segment.pts_secs.is_finite()
            || segment.pts_secs < 0.0
            || !segment.dur_secs.is_finite()
            || segment.dur_secs <= 0.0
        {
            bail!("Invalid segment sequence number or timestamp");
        }
        let entry = IndexLine {
            seq: segment.seq,
            pts: segment.pts_secs,
            dur: segment.dur_secs,
            bytes: segment.bytes,
            wall: format_wall(wall)?,
        };
        let mut line = serde_json::to_vec(&entry).context("Failed to serialize recording index")?;
        line.push(b'\n');
        if let Err(error) = self
            .file
            .write_all(&line)
            .and_then(|()| self.file.sync_data())
        {
            self.failed = true;
            return Err(error).context("Failed to write or sync recording index");
        }
        Ok(())
    }
}

/// Ignore an incomplete final line that was never published; report other JSON and I/O errors.
pub fn read_index(path: &Path) -> Result<Vec<IndexLine>> {
    let file = File::open(path).context("Failed to open recording index")?;
    let mut reader = BufReader::new(file);
    let mut entries = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader
            .read_until(b'\n', &mut line)
            .context("Failed to read recording index")?
            == 0
        {
            break;
        }
        match serde_json::from_slice(&line) {
            Ok(entry) => entries.push(entry),
            Err(error) if !line.ends_with(b"\n") && error.is_eof() => break,
            Err(error) => {
                return Err(error).with_context(|| format!("Invalid index line {}", entries.len() + 1))
            }
        }
    }
    Ok(entries)
}

pub fn write_session_json(dir: &Path, meta: &SessionMeta) -> Result<()> {
    let mut json = serde_json::to_vec(meta).context("Failed to serialize recording session metadata")?;
    json.push(b'\n');
    fs::create_dir_all(dir).context("Failed to create recording session directory")?;
    let mut file = File::create(dir.join("session.json")).context("Failed to create recording session metadata")?;
    file.write_all(&json).context("Failed to write recording session metadata")?;
    file.sync_data().context("Failed to sync recording session metadata")
}

fn repair_tail(file: &mut File) -> Result<()> {
    let len = file.metadata().context("Failed to read index length")?.len();
    let mut start = len;
    let mut buffer = [0; 4096];
    let tail_start = loop {
        if start == 0 {
            break 0;
        }
        let count = start.min(buffer.len() as u64) as usize;
        start -= count as u64;
        file.seek(SeekFrom::Start(start))
            .context("Failed to seek to the final index line")?;
        file.read_exact(&mut buffer[..count])
            .context("Failed to read the final index line")?;
        if let Some(pos) = buffer[..count].iter().rposition(|byte| *byte == b'\n') {
            break start + pos as u64 + 1;
        }
    };
    if tail_start == len {
        return Ok(());
    }
    file.seek(SeekFrom::Start(tail_start))
        .context("Failed to seek to the final index line")?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).context("Failed to read the final index line")?;
    match serde_json::from_slice::<IndexLine>(&tail) {
        Ok(_) => file.write_all(b"\n").context("Failed to complete the index line")?,
        Err(error) if error.is_eof() => {
            file.set_len(tail_start).context("Failed to remove incomplete final index line")?
        }
        Err(error) => return Err(error).context("Invalid final index line; refusing to continue writing"),
    }
    file.sync_data().context("Failed to sync repaired index tail")
}

fn format_wall(wall: SystemTime) -> Result<String> {
    let mut zone = DYNAMIC_TIME_ZONE_INFORMATION::default();
    // SAFETY: zone is a valid, writable Windows time zone structure.
    if unsafe { GetDynamicTimeZoneInformation(&mut zone) } == TIME_ZONE_ID_INVALID {
        return Err(windows::core::Error::from_thread()).context("Failed to read local timezone");
    }
    format_wall_in_zone(wall, &zone)
}

fn format_wall_in_zone(wall: SystemTime, zone: &DYNAMIC_TIME_ZONE_INFORMATION) -> Result<String> {
    const UNIX_EPOCH_FILETIME: i128 = 116_444_736_000_000_000;
    let unix_ticks = match wall.duration_since(UNIX_EPOCH) {
        Ok(duration) => (duration.as_nanos() / 100) as i128,
        Err(error) => -((error.duration().as_nanos().div_ceil(100)) as i128),
    };
    let ticks =
        u64::try_from(UNIX_EPOCH_FILETIME + unix_ticks).context("Recording time is outside the range supported by Windows")?;
    let filetime = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    let mut local_filetime = FILETIME::default();
    // SAFETY: All structures are initialized; the API reads the inputs and writes to their respective output structures.
    unsafe {
        FileTimeToSystemTime(&filetime, &mut utc).context("Failed to convert recording time to UTC")?;
        if zone.TimeZoneKeyName[0] == 0 {
            // A manually configured timezone may not have a registered name; use its fixed rules directly.
            let fixed_zone = TIME_ZONE_INFORMATION {
                Bias: zone.Bias,
                StandardName: zone.StandardName,
                StandardDate: zone.StandardDate,
                StandardBias: zone.StandardBias,
                DaylightName: zone.DaylightName,
                DaylightDate: zone.DaylightDate,
                DaylightBias: zone.DaylightBias,
            };
            SystemTimeToTzSpecificLocalTime(Some(&fixed_zone), &utc, &mut local)
                .context("Failed to convert recording time in custom timezone")?;
        } else {
            SystemTimeToTzSpecificLocalTimeEx(Some(zone), &utc, &mut local)
                .context("Failed to convert recording time to local time")?;
        }
        SystemTimeToFileTime(&local, &mut local_filetime).context("Failed to calculate recording timezone offset")?;
    }
    let local_ticks =
        (u64::from(local_filetime.dwHighDateTime) << 32) | u64::from(local_filetime.dwLowDateTime);
    // Truncate both UTC and local values to milliseconds so fractional seconds do not undercount the offset by one minute.
    let offset = (i128::from(local_ticks) - i128::from(ticks / 10_000 * 10_000)) / 600_000_000;
    let sign = if offset < 0 { '-' } else { '+' };
    let minutes = offset.abs();
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}{sign}{:02}:{:02}",
        local.wYear,
        local.wMonth,
        local.wDay,
        local.wHour,
        local.wMinute,
        local.wSecond,
        local.wMilliseconds,
        minutes / 60,
        minutes % 60,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use windows::Win32::System::Time::EnumDynamicTimeZoneInformation;

    static DIRECTORIES: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "aditorrec-index-{}-{}",
                std::process::id(),
                DIRECTORIES.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn segment(seq: u64) -> SegmentInfo {
        SegmentInfo {
            seq,
            pts_secs: (seq - 1) as f64 * 2.0,
            dur_secs: 2.0,
            bytes: 12_345,
        }
    }

    fn named_zone(name: &str) -> DYNAMIC_TIME_ZONE_INFORMATION {
        for index in 0.. {
            let mut zone = DYNAMIC_TIME_ZONE_INFORMATION::default();
            // SAFETY: Provide a valid writable structure; this only enumerates Windows timezones and does not change system settings.
            let status = unsafe { EnumDynamicTimeZoneInformation(index, &mut zone) };
            assert_eq!(status, 0, "Test timezone not found: {name}");
            let end = zone.TimeZoneKeyName.iter().position(|c| *c == 0).unwrap();
            if String::from_utf16(&zone.TimeZoneKeyName[..end]).unwrap() == name {
                return zone;
            }
        }
        unreachable!()
    }

    #[test]
    fn append_is_visible_before_drop_and_reopening_preserves_existing_lines() {
        let dir = TestDir::new();
        let wall = UNIX_EPOCH + Duration::from_millis(1_792_332_185_123);
        let mut writer = IndexWriter::create(&dir.0).unwrap();
        writer.append(&segment(1), wall).unwrap();
        let entries = read_index(&dir.0.join("index.jsonl")).unwrap();
        assert_eq!(
            entries,
            vec![IndexLine {
                seq: 1,
                pts: 0.0,
                dur: 2.0,
                bytes: 12_345,
                wall: format_wall(wall).unwrap()
            }]
        );
        drop(writer);
        let mut reopened = IndexWriter::create(&dir.0).unwrap();
        reopened
            .append(&segment(2), wall + Duration::from_secs(2))
            .unwrap();
        let entries = read_index(&dir.0.join("index.jsonl")).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].seq, 2);
        assert_eq!(entries[1].pts, 2.0);
        assert!(fs::read(dir.0.join("index.jsonl"))
            .unwrap()
            .ends_with(b"\n"));
    }

    #[test]
    fn incomplete_tail_is_ignored_then_removed_before_appending() {
        let dir = TestDir::new();
        let path = dir.0.join("index.jsonl");
        let mut writer = IndexWriter::create(&dir.0).unwrap();
        writer.append(&segment(1), UNIX_EPOCH).unwrap();
        drop(writer);
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(br#"{"seq":2,"pts":2.0,"dur":2.0,"wall":"#)
            .unwrap();
        assert_eq!(read_index(&path).unwrap().len(), 1);
        let mut writer = IndexWriter::create(&dir.0).unwrap();
        writer.append(&segment(2), UNIX_EPOCH).unwrap();
        assert_eq!(
            read_index(&path)
                .unwrap()
                .iter()
                .map(|entry| entry.seq)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        drop(writer);
        fs::write(&path, br#"{"seq":"#).unwrap();
        assert!(read_index(&path).unwrap().is_empty());
        let _writer = IndexWriter::create(&dir.0).unwrap();
        assert!(fs::read(&path).unwrap().is_empty());
    }

    #[test]
    fn complete_final_json_without_newline_is_preserved() {
        let dir = TestDir::new();
        let path = dir.0.join("index.jsonl");
        let mut writer = IndexWriter::create(&dir.0).unwrap();
        writer.append(&segment(1), UNIX_EPOCH).unwrap();
        drop(writer);
        let mut bytes = fs::read(&path).unwrap();
        bytes.pop();
        fs::write(&path, &bytes).unwrap();
        assert_eq!(read_index(&path).unwrap().len(), 1);
        let mut writer = IndexWriter::create(&dir.0).unwrap();
        writer.append(&segment(2), UNIX_EPOCH).unwrap();
        assert_eq!(read_index(&path).unwrap().len(), 2);
    }

    #[test]
    fn corrupt_complete_lines_and_io_failures_are_not_silently_ignored() {
        let dir = TestDir::new();
        let path = dir.0.join("index.jsonl");
        assert!(read_index(&path).is_err());
        for bytes in [b"not json".as_slice(), b"{\"seq\":\n", b"{}\n"] {
            fs::write(&path, bytes).unwrap();
            assert!(read_index(&path).is_err());
        }
        fs::write(&path, b"not json").unwrap();
        assert!(IndexWriter::create(&dir.0).is_err());
        fs::write(dir.0.join("blocked"), b"not a directory").unwrap();
        assert!(IndexWriter::create(&dir.0.join("blocked")).is_err());
        fs::create_dir(dir.0.join("session.json")).unwrap();
        assert!(write_session_json(&dir.0, &meta()).is_err());
    }

    #[test]
    fn invalid_segments_leave_index_unchanged() {
        let dir = TestDir::new();
        let mut writer = IndexWriter::create(&dir.0).unwrap();
        for bad in [
            SegmentInfo {
                seq: 0,
                ..segment(1)
            },
            SegmentInfo {
                pts_secs: f64::NAN,
                ..segment(1)
            },
            SegmentInfo {
                pts_secs: -1.0,
                ..segment(1)
            },
            SegmentInfo {
                dur_secs: f64::INFINITY,
                ..segment(1)
            },
            SegmentInfo {
                dur_secs: 0.0,
                ..segment(1)
            },
        ] {
            assert!(writer.append(&bad, UNIX_EPOCH).is_err());
        }
        assert!(read_index(&dir.0.join("index.jsonl")).unwrap().is_empty());
        writer.append(&segment(1), UNIX_EPOCH).unwrap();
    }

    #[test]
    fn failed_write_is_reported_and_prevents_further_appends() {
        let dir = TestDir::new();
        let path = dir.0.join("index.jsonl");
        fs::write(&path, []).unwrap();
        let mut writer = IndexWriter {
            file: File::open(&path).unwrap(),
            failed: false,
        };
        assert!(writer.append(&segment(1), UNIX_EPOCH).is_err());
        assert!(writer.failed);
        assert!(writer
            .append(&segment(2), UNIX_EPOCH)
            .unwrap_err()
            .to_string()
            .contains("reopen the index"));
        assert!(fs::read(&path).unwrap().is_empty());
    }

    fn meta() -> SessionMeta {
        SessionMeta {
            session_id: "20261018-210305-ab12".into(),
            started_at: "2026-10-18T21:03:05.123+08:00".into(),
            encoder: "hevc_nvenc".into(),
            width: 2560,
            height: 1440,
            fps: 60,
            codec: Codec::Hevc,
            audio: true,
            aditorrec_version: env!("CARGO_PKG_VERSION").into(),
        }
    }

    #[test]
    fn session_json_round_trip_contains_all_snapshot_fields() {
        let dir = TestDir::new();
        let meta = meta();
        write_session_json(&dir.0, &meta).unwrap();
        let bytes = fs::read(dir.0.join("session.json")).unwrap();
        assert_eq!(serde_json::from_slice::<SessionMeta>(&bytes).unwrap(), meta);
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 9);
        assert_eq!(value["codec"], "hevc");
        assert_eq!(value["started_at"], "2026-10-18T21:03:05.123+08:00");
    }

    #[test]
    fn iso8601_handles_fractional_offsets_rollovers_and_pre_unix_epoch() {
        let taipei = named_zone("Taipei Standard Time");
        let west = named_zone("Newfoundland Standard Time");
        assert_eq!(
            format_wall_in_zone(UNIX_EPOCH, &taipei).unwrap(),
            "1970-01-01T08:00:00.000+08:00"
        );
        assert_eq!(
            format_wall_in_zone(UNIX_EPOCH + Duration::from_nanos(123_456_789), &west).unwrap(),
            "1969-12-31T20:30:00.123-03:30"
        );
        assert_eq!(
            format_wall_in_zone(UNIX_EPOCH - Duration::from_millis(1), &taipei).unwrap(),
            "1970-01-01T07:59:59.999+08:00"
        );
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(
            format_wall_in_zone(leap, &taipei).unwrap(),
            "2000-02-29T08:00:00.000+08:00"
        );
    }

    #[test]
    fn iso8601_uses_offset_at_the_given_instant_across_dst_transition() {
        let zone = named_zone("Eastern Standard Time");
        assert_eq!(
            format_wall_in_zone(UNIX_EPOCH + Duration::from_secs(1_710_053_999), &zone).unwrap(),
            "2024-03-10T01:59:59.000-05:00"
        );
        assert_eq!(
            format_wall_in_zone(UNIX_EPOCH + Duration::from_secs(1_710_054_000), &zone).unwrap(),
            "2024-03-10T03:00:00.000-04:00"
        );
    }

    #[test]
    fn iso8601_supports_custom_timezones_without_registry_names() {
        let zone = DYNAMIC_TIME_ZONE_INFORMATION {
            Bias: -345,
            ..Default::default()
        };
        assert_eq!(
            format_wall_in_zone(UNIX_EPOCH, &zone).unwrap(),
            "1970-01-01T05:45:00.000+05:45"
        );
    }
}
