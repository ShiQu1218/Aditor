//! Process enumeration using Toolhelp32 snapshots without touching D3D, audio, or encoders.

use std::mem::size_of;

use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_FILES, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

use crate::protocol::ProcessInfo;

struct SnapshotHandle(HANDLE);

impl Drop for SnapshotHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: Closes the snapshot handle exclusively owned by this guard.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// Returns true if `name` starts with any prefix in `prefixes` (ASCII case-insensitive).
pub fn matches_any_prefix(name: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| {
        name.get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
    })
}

/// Filters `(name, pid)` entries to those matching `prefixes` (ASCII case-insensitive).
#[cfg(test)]
pub fn filter_processes<'a>(
    entries: impl IntoIterator<Item = (&'a str, u32)>,
    prefixes: &[String],
) -> Vec<ProcessInfo> {
    entries
        .into_iter()
        .filter(|(name, _)| matches_any_prefix(name, prefixes))
        .map(|(name, pid)| ProcessInfo {
            name: name.to_string(),
            pid,
        })
        .collect()
}

/// Lists running processes whose image name starts with one of `prefixes` (ASCII case-insensitive).
pub fn query(prefixes: &[String]) -> Result<Vec<ProcessInfo>, String> {
    if prefixes.is_empty() {
        return Ok(Vec::new());
    }
    // SAFETY: TH32CS_SNAPPROCESS captures a read-only process snapshot; the returned handle is owned by SnapshotHandle.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| format!("CreateToolhelp32Snapshot failed: {error}"))?;
    let snapshot = SnapshotHandle(raw);

    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    let no_more_files = ERROR_NO_MORE_FILES.to_hresult();
    // SAFETY: `snapshot.0` is a valid Toolhelp32 snapshot handle and `entry.dwSize` is initialized.
    if let Err(error) = unsafe { Process32FirstW(snapshot.0, &mut entry) } {
        if error.code() == no_more_files {
            return Ok(Vec::new());
        }
        return Err(format!("Process32FirstW failed: {error}"));
    }

    let mut matches = Vec::new();
    loop {
        let nul = entry
            .szExeFile
            .iter()
            .position(|&ch| ch == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..nul]);
        if matches_any_prefix(&name, prefixes) {
            matches.push(ProcessInfo {
                name,
                pid: entry.th32ProcessID,
            });
        }
        // SAFETY: `snapshot.0` is valid and `entry.dwSize` remains set to sizeof(PROCESSENTRY32W).
        if let Err(error) = unsafe { Process32NextW(snapshot.0, &mut entry) } {
            if error.code() == no_more_files {
                break;
            }
            return Err(format!("Process32NextW failed: {error}"));
        }
    }
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_filter_matches_case_insensitively_and_preserves_pids() {
        let entries = [
            ("r5apex.exe", 101),
            ("R5APEX_DX12.EXE", 202),
            ("r5apex_launcher.exe", 303),
            ("valorant-win64-shipping.exe", 404),
            ("svchost.exe", 4),
        ];
        let prefixes = vec!["r5apex".to_string(), "VALORANT-Win64-Shipping".to_string()];
        assert_eq!(
            filter_processes(entries, &prefixes),
            vec![
                ProcessInfo {
                    name: "r5apex.exe".into(),
                    pid: 101
                },
                ProcessInfo {
                    name: "R5APEX_DX12.EXE".into(),
                    pid: 202
                },
                ProcessInfo {
                    name: "r5apex_launcher.exe".into(),
                    pid: 303
                },
                ProcessInfo {
                    name: "valorant-win64-shipping.exe".into(),
                    pid: 404
                },
            ]
        );
        assert!(filter_processes(entries, &[]).is_empty());
    }

    #[test]
    fn snapshot_finds_current_process_by_exe_prefix() {
        let exe = std::env::current_exe().unwrap();
        let stem = exe.file_stem().unwrap().to_str().unwrap();
        let prefix = stem.get(..stem.len().min(6)).unwrap_or(stem);
        let pid = std::process::id();
        let results = query(&[prefix.to_ascii_uppercase()]).unwrap();
        assert!(
            results.iter().any(|p| p.pid == pid),
            "expected pid {pid} for prefix {prefix:?} in {results:?}"
        );
    }
}
