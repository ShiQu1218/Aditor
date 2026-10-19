// 儲存位置：一個根資料夾，底下固定的子資料夾（名稱不隨介面語言改變，路徑才穩定）。
//   <根>/Recordings/<YYYY-MM-DD>/Apex_….mp4     內建錄影與 OBS 逐局剪出的檔案，依日期分資料夾
//   <根>/Exports/Merged/…                        剪輯輸出：合併成一支
//   <根>/Exports/Clips/…                         剪輯輸出：一段一段分開輸出
// 本檔不使用 Node 的 path，main 與 renderer 都能用。

export const RECORDINGS_DIRNAME = 'Recordings'
export const EXPORTS_DIRNAME = 'Exports'
export const EXPORT_MERGED_DIRNAME = 'Merged'
export const EXPORT_CLIPS_DIRNAME = 'Clips'

/** 匯出模式 → 子資料夾名稱：合併（concat）與一段一段輸出（separate）分開存放。 */
export function exportSubDirName(mode: 'concat' | 'separate'): string {
  return mode === 'concat' ? EXPORT_MERGED_DIRNAME : EXPORT_CLIPS_DIRNAME
}

/** 依 `base` 已用的分隔符（\ 或 /）接上一段路徑，用於顯示預覽；實際讀寫請用 Node 的 path.join。 */
export function joinForDisplay(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') || /^[A-Za-z]:/.test(base) ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 毫秒時間戳（Unix epoch）→ 本機日期資料夾名稱 `YYYY-MM-DD`。 */
export function dayFolderName(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export const DAY_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/
