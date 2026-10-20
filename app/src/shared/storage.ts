// Storage layout: one root folder with fixed subfolders (names do not vary by UI language, keeping paths stable).
//   <root>/Recordings/<YYYY-MM-DD>/Apex_….mp4     Built-in recordings and OBS match clips, grouped by date
//   <root>/Exports/Merged/…                        Merged clip export
//   <root>/Exports/Clips/…                         Separate clip exports
// This file does not use Node's path module, so both main and renderer can use it.

export const RECORDINGS_DIRNAME = 'Recordings'
export const EXPORTS_DIRNAME = 'Exports'
export const EXPORT_MERGED_DIRNAME = 'Merged'
export const EXPORT_CLIPS_DIRNAME = 'Clips'

/** Map export modes to subfolder names: merged (concat) and separate outputs (separate) are stored apart. */
export function exportSubDirName(mode: 'concat' | 'separate'): string {
  return mode === 'concat' ? EXPORT_MERGED_DIRNAME : EXPORT_CLIPS_DIRNAME
}

/** Append path parts using the separator already used by `base` (\ or /), for display previews; use Node's path.join for actual I/O. */
export function joinForDisplay(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') || /^[A-Za-z]:/.test(base) ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Convert a Unix epoch timestamp in milliseconds to a local date folder name, `YYYY-MM-DD`. */
export function dayFolderName(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export const DAY_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/
