import type { CategoryId, SettingRow } from './rows'

export interface FilterResult {
  byCategory: Record<CategoryId, SettingRow[]>
  /** Number of matches per category; categories without matches are omitted. */
  counts: Partial<Record<CategoryId, number>>
}

/** Every whitespace-separated term must match a title, description, keyword, or card name, case-insensitively. */
function matches(row: SettingRow, terms: string[]): boolean {
  const hay = [row.title, row.desc ?? '', row.card, ...(row.keywords ?? [])].join('\n').toLowerCase()
  return terms.every((term) => hay.includes(term))
}

export function filterRows(rows: readonly SettingRow[], query: string): FilterResult {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const byCategory: Record<CategoryId, SettingRow[]> = { general: [], recording: [], analysis: [], editing: [], export: [], about: [] }
  const counts: Partial<Record<CategoryId, number>> = {}
  for (const row of rows) {
    if (terms.length > 0 && !matches(row, terms)) continue
    byCategory[row.category].push(row)
    counts[row.category] = (counts[row.category] ?? 0) + 1
  }
  return { byCategory, counts }
}
