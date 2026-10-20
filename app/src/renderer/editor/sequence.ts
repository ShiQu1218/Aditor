import type { Project, ProjectItem } from './project'

/**
 * Playback sequence for project mode (Task 13):
 * Continue the current clip while `t < item.end`; switch to the next clip when `t >= item.end` (including across videos); stop after the final clip.
 */
export type NextStep =
  | { kind: 'continue' }
  | { kind: 'next'; item: ProjectItem }
  | { kind: 'end' }
  /** More clips follow, but all their source files are missing. */
  | { kind: 'allMissing' }

/** Find the first clip after itemId whose source exists; return end if there are no later clips, or allMissing if all later sources are missing. */
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
