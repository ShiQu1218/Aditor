import type { Project, ProjectItem } from './project'

/**
 * 專案模式的播放序列（Task 13）：
 * `t < item.end` 續播同一段；`t >= item.end` 換下一段（可跨影片）；最後一段播完即結束。
 */
export type NextStep = { kind: 'continue' } | { kind: 'next'; item: ProjectItem } | { kind: 'end' }

export function nextAfter(project: Project, itemId: string, t: number): NextStep {
  const idx = project.items.findIndex((i) => i.id === itemId)
  const item = idx >= 0 ? project.items[idx] : undefined
  if (!item) return { kind: 'end' }
  if (t < item.end) return { kind: 'continue' }
  const next = idx + 1 < project.items.length ? project.items[idx + 1] : undefined
  return next ? { kind: 'next', item: next } : { kind: 'end' }
}
