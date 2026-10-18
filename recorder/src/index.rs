//! `index.jsonl`／`session.json` 寫入（任務 B4，規格 §2.1）。
//! 每段一行 `{"seq":1,"pts":0.0,"dur":2.0,"bytes":123,"wall":"2026-10-18T21:03:05.123+08:00"}`；
//! 每行寫完即 `sync_data`，讓崩潰後的檔案仍是完整行（最後一行若不完整，讀端忽略）。

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
    /// ISO8601，包含時區；由工作啟動時間填入，不受重開索引影響。
    pub started_at: String,
    pub encoder: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Codec,
    pub audio: bool,
    pub apexrec_version: String,
}

pub struct IndexWriter {
    file: File,
    failed: bool,
}

impl IndexWriter {
    /// 保留既有完整行，修復崩潰留下的不完整尾行，再繼續附加。
    pub fn create(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir).context("建立錄影索引目錄失敗")?;
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(dir.join("index.jsonl"))
            .context("開啟錄影索引失敗")?;
        repair_tail(&mut file)?;
        file.seek(SeekFrom::End(0))
            .context("定位索引附加位置失敗")?;
        Ok(Self {
            file,
            failed: false,
        })
    }

    /// 呼叫端必須先完成段落檔案的 flush 與 sync，再公布索引。
    pub fn append(&mut self, segment: &SegmentInfo, wall: SystemTime) -> Result<()> {
        if self.failed {
            bail!("索引先前寫入失敗，必須重新開啟後才能繼續");
        }
        if segment.seq == 0
            || !segment.pts_secs.is_finite()
            || segment.pts_secs < 0.0
            || !segment.dur_secs.is_finite()
            || segment.dur_secs <= 0.0
        {
            bail!("段落序號或時間無效");
        }
        let entry = IndexLine {
            seq: segment.seq,
            pts: segment.pts_secs,
            dur: segment.dur_secs,
            bytes: segment.bytes,
            wall: format_wall(wall)?,
        };
        let mut line = serde_json::to_vec(&entry).context("序列化錄影索引失敗")?;
        line.push(b'\n');
        if let Err(error) = self
            .file
            .write_all(&line)
            .and_then(|()| self.file.sync_data())
        {
            self.failed = true;
            return Err(error).context("寫入或同步錄影索引失敗");
        }
        Ok(())
    }
}

/// 不完整的最後一行尚未公布，忽略；其他 JSON 錯誤與 I/O 錯誤仍回報。
pub fn read_index(path: &Path) -> Result<Vec<IndexLine>> {
    let file = File::open(path).context("開啟錄影索引失敗")?;
    let mut reader = BufReader::new(file);
    let mut entries = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader
            .read_until(b'\n', &mut line)
            .context("讀取錄影索引失敗")?
            == 0
        {
            break;
        }
        match serde_json::from_slice(&line) {
            Ok(entry) => entries.push(entry),
            Err(error) if !line.ends_with(b"\n") && error.is_eof() => break,
            Err(error) => {
                return Err(error).with_context(|| format!("索引第 {} 行無效", entries.len() + 1))
            }
        }
    }
    Ok(entries)
}

pub fn write_session_json(dir: &Path, meta: &SessionMeta) -> Result<()> {
    let mut json = serde_json::to_vec(meta).context("序列化錄影設定失敗")?;
    json.push(b'\n');
    fs::create_dir_all(dir).context("建立錄影設定目錄失敗")?;
    let mut file = File::create(dir.join("session.json")).context("建立錄影設定失敗")?;
    file.write_all(&json).context("寫入錄影設定失敗")?;
    file.sync_data().context("同步錄影設定失敗")
}

fn repair_tail(file: &mut File) -> Result<()> {
    let len = file.metadata().context("讀取索引長度失敗")?.len();
    let mut start = len;
    let mut buffer = [0; 4096];
    let tail_start = loop {
        if start == 0 {
            break 0;
        }
        let count = start.min(buffer.len() as u64) as usize;
        start -= count as u64;
        file.seek(SeekFrom::Start(start))
            .context("定位索引尾行失敗")?;
        file.read_exact(&mut buffer[..count])
            .context("讀取索引尾行失敗")?;
        if let Some(pos) = buffer[..count].iter().rposition(|byte| *byte == b'\n') {
            break start + pos as u64 + 1;
        }
    };
    if tail_start == len {
        return Ok(());
    }
    file.seek(SeekFrom::Start(tail_start))
        .context("定位索引尾行失敗")?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).context("讀取索引尾行失敗")?;
    match serde_json::from_slice::<IndexLine>(&tail) {
        Ok(_) => file.write_all(b"\n").context("補齊索引換行失敗")?,
        Err(error) if error.is_eof() => {
            file.set_len(tail_start).context("截除索引不完整尾行失敗")?
        }
        Err(error) => return Err(error).context("索引尾行無效，拒絕繼續寫入"),
    }
    file.sync_data().context("同步索引尾行修復失敗")
}

fn format_wall(wall: SystemTime) -> Result<String> {
    let mut zone = DYNAMIC_TIME_ZONE_INFORMATION::default();
    // SAFETY: zone 是有效且可寫入的 Windows 時區結構。
    if unsafe { GetDynamicTimeZoneInformation(&mut zone) } == TIME_ZONE_ID_INVALID {
        return Err(windows::core::Error::from_thread()).context("讀取本地時區失敗");
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
        u64::try_from(UNIX_EPOCH_FILETIME + unix_ticks).context("錄影時間超出 Windows 支援範圍")?;
    let filetime = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    let mut local_filetime = FILETIME::default();
    // SAFETY: 所有結構皆已初始化；API 只讀輸入並寫入各自的輸出結構。
    unsafe {
        FileTimeToSystemTime(&filetime, &mut utc).context("轉換錄影 UTC 時間失敗")?;
        if zone.TimeZoneKeyName[0] == 0 {
            // 手動設定的時區可能沒有登錄名稱，直接使用其固定規則。
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
                .context("轉換錄影自訂時區時間失敗")?;
        } else {
            SystemTimeToTzSpecificLocalTimeEx(Some(zone), &utc, &mut local)
                .context("轉換錄影本地時間失敗")?;
        }
        SystemTimeToFileTime(&local, &mut local_filetime).context("計算錄影時區偏移失敗")?;
    }
    let local_ticks =
        (u64::from(local_filetime.dwHighDateTime) << 32) | u64::from(local_filetime.dwLowDateTime);
    // UTC 與本地值皆截到毫秒，差值才不會因小數秒而少算一分鐘。
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
                "apexrec-index-{}-{}",
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
            // SAFETY: 提供有效的可寫入結構；只列舉 Windows 時區，不變更系統設定。
            let status = unsafe { EnumDynamicTimeZoneInformation(index, &mut zone) };
            assert_eq!(status, 0, "找不到測試時區 {name}");
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
        fs::write(dir.0.join("blocked"), "不是目錄".as_bytes()).unwrap();
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
            .contains("必須重新開啟"));
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
            apexrec_version: env!("CARGO_PKG_VERSION").into(),
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
