import type { SettingsRange } from '../../shared/settings'
export { fillTemplate } from '../../shared/template'

/** Clamp to the valid range and round to an integer; return null for non-finite numbers (callers must not submit them). */
export function clampToRange(range: SettingsRange, value: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/** Keyboard navigation for tablists: arrow keys wrap, Home/End jump; return null for other keys. */
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
