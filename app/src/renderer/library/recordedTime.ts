import type { LibraryEntry } from '../../main/library'
import { fileName } from './cardLogic'

/** 錄影檔名使用本地時間；逐欄核對，避免 Date 將無效日期自動進位。 */
function recorderDate(path: string): Date | null {
  const match = /^Apex_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:_[1-9]\d*)?\.mp4$/i.exec(fileName(path))
  if (!match) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  const date = new Date(year, month - 1, day, hour, minute)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day &&
    date.getHours() === hour && date.getMinutes() === minute ? date : null
}

/** 錄影時間：辨識錄影器檔名，其他影片回退加入影片庫的時間。 */
export function recordedTime(entry: Pick<LibraryEntry, 'path' | 'addedAt'>): number {
  return recorderDate(entry.path)?.getTime() ?? entry.addedAt
}

export function studioVideoTitle(path: string): string {
  const date = recorderDate(path)
  return date ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : fileName(path).replace(/\.[^.]+$/, '')
}
