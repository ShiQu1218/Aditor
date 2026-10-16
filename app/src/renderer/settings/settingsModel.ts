import type { SettingsRange } from '../../shared/settings'

/** 夾限到合法範圍並四捨五入為整數；非有限數字回 null（呼叫端不應送出）。 */
export function clampToRange(range: SettingsRange, value: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/** tablist 的鍵盤導覽：方向鍵循環、Home／End；其他按鍵回 null（不處理）。 */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return (index + 1) % count
    case 'ArrowUp':
    case 'ArrowLeft':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`
}

/** 取代 `{name}` 佔位符。 */
export function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
