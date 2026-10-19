import { tr } from '../../shared/locale'
export interface ProjectItem {
  id: string
  source: string
  start: number
  end: number
}

export interface Project {
  version: 1
  name: string
  items: ProjectItem[]
}

export function createProject(name = 'New Project', items: ProjectItem[] = []): Project {
  return {
    version: 1,
    name,
    items
  }
}

export function totalDuration(p: Project): number {
  return p.items.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0)
}

export function addItems(
  p: Project,
  items: Array<Omit<ProjectItem, 'id'> & { id?: string }>
): Project {
  const newItems: ProjectItem[] = items.map((item) => ({
    ...item,
    id: item.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  }))
  return {
    ...p,
    items: [...p.items, ...newItems]
  }
}

export function removeItem(p: Project, id: string): Project {
  return {
    ...p,
    items: p.items.filter((item) => item.id !== id)
  }
}

export function splitItem(p: Project, id: string, atSourceTime: number): Project {
  const index = p.items.findIndex((item) => item.id === id)
  if (index === -1) return p

  const item = p.items[index]
  if (atSourceTime <= item.start || atSourceTime >= item.end) {
    return p
  }

  const first: ProjectItem = {
    ...item,
    end: atSourceTime
  }
  const second: ProjectItem = {
    id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    source: item.source,
    start: atSourceTime,
    end: item.end
  }

  const nextItems = [...p.items]
  nextItems.splice(index, 1, first, second)
  return {
    ...p,
    items: nextItems
  }
}

export function duplicateItem(p: Project, id: string): Project {
  const index = p.items.findIndex((item) => item.id === id)
  if (index === -1) return p

  const item = p.items[index]
  const clone: ProjectItem = {
    ...item,
    id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  }

  const nextItems = [...p.items]
  nextItems.splice(index + 1, 0, clone)
  return {
    ...p,
    items: nextItems
  }
}

export function moveItem(p: Project, id: string, toIndex: number): Project {
  const fromIndex = p.items.findIndex((item) => item.id === id)
  if (fromIndex === -1) return p

  const targetIndex = Math.max(0, Math.min(toIndex, p.items.length - 1))
  if (fromIndex === targetIndex) return p

  const nextItems = [...p.items]
  const [removed] = nextItems.splice(fromIndex, 1)
  nextItems.splice(targetIndex, 0, removed)
  return {
    ...p,
    items: nextItems
  }
}

export function trimItem(
  p: Project,
  id: string,
  edge: 'start' | 'end',
  t: number,
  sourceDuration?: number
): Project {
  const index = p.items.findIndex((item) => item.id === id)
  if (index === -1) return p

  const item = p.items[index]
  let newStart = item.start
  let newEnd = item.end

  if (edge === 'start') {
    const minStart = 0
    const maxStart = item.end - 0.1
    newStart = Math.max(minStart, Math.min(t, maxStart))
    newStart = Math.round(newStart * 1000) / 1000
  } else {
    const minEnd = item.start + 0.1
    const maxEnd = sourceDuration !== undefined ? sourceDuration : Infinity
    newEnd = Math.max(minEnd, Math.min(t, maxEnd))
    newEnd = Math.round(newEnd * 1000) / 1000
  }

  const updatedItem: ProjectItem = {
    ...item,
    start: newStart,
    end: newEnd
  }

  const nextItems = [...p.items]
  nextItems[index] = updatedItem
  return {
    ...p,
    items: nextItems
  }
}

export type ProjectShapeError = { kind: 'unsupported' | 'format'; message: string }

/** Validate arbitrary data as a project (version, name, and each item shape); return null when valid. */
export function projectShapeError(data: unknown): ProjectShapeError | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'format', message: tr('不是專案物件') }
  const d = data as Record<string, unknown>
  if (typeof d.version === 'number' && d.version > 1) {
    return { kind: 'unsupported', message: tr('不支援的專案版本 {version}（unsupported version）', { version: d.version }) }
  }
  if (d.version !== 1) return { kind: 'format', message: tr('版本欄位無效') }
  if (typeof d.name !== 'string') return { kind: 'format', message: 'name 必須是字串' }
  if (!Array.isArray(d.items)) return { kind: 'format', message: 'items 必須是陣列' }
  for (const [i, it] of d.items.entries()) {
    const x = it as Partial<ProjectItem> | null
    const ok =
      !!x &&
      typeof x === 'object' &&
      typeof x.id === 'string' &&
      x.id.length > 0 &&
      typeof x.source === 'string' &&
      x.source.length > 0 &&
      typeof x.start === 'number' &&
      Number.isFinite(x.start) &&
      typeof x.end === 'number' &&
      Number.isFinite(x.end)
    if (!ok) return { kind: 'format', message: tr('items[{i}] 格式不符', { i }) }
  }
  return null
}
