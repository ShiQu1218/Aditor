import type { CategoryId, SettingRow } from './rows'

export interface FilterResult {
  byCategory: Record<CategoryId, SettingRow[]>
  /** 各分類的命中數；沒有命中的分類不出現 */
  counts: Partial<Record<CategoryId, number>>
}

/** 空白分隔的每個詞都必須命中（標題／說明／關鍵字／卡片名任一欄位）；大小寫不敏感。 */
function matches(row: SettingRow, terms: string[]): boolean {
  const hay = [row.title, row.desc ?? '', row.card, ...(row.keywords ?? [])].join('\n').toLowerCase()
  return terms.every((term) => hay.includes(term))
}

export function filterRows(rows: readonly SettingRow[], query: string): FilterResult {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const byCategory: Record<CategoryId, SettingRow[]> = { a: [], b: [], c: [], recording: [] }
  const counts: Partial<Record<CategoryId, number>> = {}
  for (const row of rows) {
    if (terms.length > 0 && !matches(row, terms)) continue
    byCategory[row.category].push(row)
    counts[row.category] = (counts[row.category] ?? 0) + 1
  }
  return { byCategory, counts }
}
