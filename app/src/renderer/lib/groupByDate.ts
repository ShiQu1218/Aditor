// Group library items by the local date of addedAt, newest first; items within each group are also newest first.
import type { LibraryEntry } from '../../main/library'
import { i18n } from '../i18n'

export interface DateGroup {
/** Local date key, e.g. 2026-10-16. */
  key: string
/** Today, yesterday, or a formatted date such as October 13, 2026. */
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
  // Map preserves insertion order (already sorted by addedAt newest-first), so groups are newest-first too.
  return [...groups.values()]
}
