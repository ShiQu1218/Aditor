import type { Project, ProjectItem } from './project'

/**
 * 專案模式的播放序列（Task 13）：
 * `t < item.end` 續播同一段；`t >= item.end` 換下一段（可跨影片）；最後一段播完即結束。
 */
export type NextStep =
  | { kind: 'continue' }
  | { kind: 'next'; item: ProjectItem }
  | { kind: 'end' }
  /** 後面還有片段，但來源檔案全都不存在 */
  | { kind: 'allMissing' }

/** itemId 之後第一個來源存在的片段；後面沒有片段 → end；有但全部缺失 → allMissing。 */
export function nextPlayableItem(
  project: Project,
  itemId: string,
  missingIds: ReadonlySet<string>
): { kind: 'item'; item: ProjectItem } | { kind: 'allMissing' } | { kind: 'end' } {
  const idx = project.items.findIndex((i) => i.id === itemId)
  if (idx < 0 || idx + 1 >= project.items.length) return { kind: 'end' }
  for (let i = idx + 1; i < project.items.length; i++) {
    if (!missingIds.has(project.items[i].id)) return { kind: 'item', item: project.items[i] }
  }
  return { kind: 'allMissing' }
}

export function nextAfter(
  project: Project,
  itemId: string,
  t: number,
  missingIds: ReadonlySet<string> = new Set()
): NextStep {
  const idx = project.items.findIndex((i) => i.id === itemId)
  const item = idx >= 0 ? project.items[idx] : undefined
  if (!item) return { kind: 'end' }
  if (t < item.end) return { kind: 'continue' }
  const r = nextPlayableItem(project, itemId, missingIds)
  return r.kind === 'item' ? { kind: 'next', item: r.item } : r
}
