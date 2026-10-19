// 影片庫日期分組：依 addedAt 的「本地日期」分組，新到舊；組內亦新到舊。
import type { LibraryEntry } from '../../main/library'
import { i18n } from '../i18n'

export interface DateGroup {
  /** 本地日期 key，例如 2026-10-16 */
  key: string
  /** 今天／昨天／2026 年 10 月 13 日 */
  label: string
  entries: LibraryEntry[]
}

function dateKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function labelFor(d: Date, today: string, yesterday: string): string {
  const key = dateKey(d)
  if (key === today) return i18n.library.date.today
  if (key === yesterday) return i18n.library.date.yesterday
  return i18n.library.date.header
    .replace('{y}', String(d.getFullYear()))
    .replace('{m}', String(d.getMonth() + 1))
    .replace('{d}', String(d.getDate()))
}

export function groupByDate(entries: LibraryEntry[], now: number = Date.now()): DateGroup[] {
  const nowDate = new Date(now)
  const today = dateKey(nowDate)
  const yesterday = dateKey(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1))

  const groups = new Map<string, DateGroup>()
  const sorted = [...entries].sort((a, b) => b.addedAt - a.addedAt)
  for (const entry of sorted) {
    const d = new Date(entry.addedAt)
    const key = dateKey(d)
    let group = groups.get(key)
    if (!group) {
      group = { key, label: labelFor(d, today, yesterday), entries: [] }
      groups.set(key, group)
    }
    group.entries.push(entry)
  }
  // Map 依照插入順序（已依 addedAt 新到舊），即群組新到舊
  return [...groups.values()]
}
