// Pure keyboard movement rules for roving tabindex, shared by grids, lists, and tracks.

export type RovingOrientation = 'grid' | 'vertical' | 'horizontal'

export interface RovingParams {
/** Total number of items. */
  count: number
/** Current cursor index (-1 means no cursor yet). */
  index: number
  key: string
/** Number of grid columns (use 1 for a vertical list). */
  columns: number
/** grid responds in four directions; vertical responds only to ↑↓; horizontal only to ←→ (defaults to grid). */
  orientation?: RovingOrientation
}

/**
 * Return the new cursor index after a key press; return null for unsupported keys or when already at an edge.
 * ←→ moves one item; ↑↓ moves one row (stopping at the last item in a shorter final row); Home/End moves to either end. Movement does not wrap.
 */
export function rovingStep({ count, index, key, columns, orientation = 'grid' }: RovingParams): number | null {
  if (count <= 0) return null
  const cols = Math.max(1, Math.floor(columns) || 1)
  const last = count - 1
  const from = index < 0 ? -1 : Math.min(index, last)
  const horizontal = orientation !== 'vertical'
  const vertical = orientation !== 'horizontal'
  let next: number
  switch (key) {
    case 'Home':
      next = 0
      break
    case 'End':
      next = last
      break
    case 'ArrowRight':
      if (!horizontal) return null
      next = from + 1
      break
    case 'ArrowLeft':
      if (!horizontal) return null
      next = from < 0 ? 0 : from - 1
      break
    case 'ArrowDown': {
      if (!vertical) return null
      const step = orientation === 'grid' ? cols : 1
      if (from < 0) next = 0
      else if (from + step <= last) next = from + step
      else if (Math.floor(from / step) < Math.floor(last / step)) next = last // The next row is shorter.
      else return null
      break
    }
    case 'ArrowUp': {
      if (!vertical) return null
      const step = orientation === 'grid' ? cols : 1
      next = from < 0 ? 0 : from - step
      break
    }
    default:
      return null
  }
  if (next < 0 || next > last || next === from) return null
  return next
}

export interface GridPos {
  group: number
  index: number
}

export interface GridStepParams {
/** Number of items in each date group. */
  groups: number[]
  group: number
  index: number
  key: string
  columns: number
}

/**
 * Move the cursor in the date-grouped library grid: use rovingStep within a group.
 * At group boundaries, ←→ and ↑↓ continue into the adjacent non-empty group (↑↓ preserves the column and clamps to that row's range); Home/End targets the ends of the whole grid.
 */
export function gridStep({ groups, group, index, key, columns }: GridStepParams): GridPos | null {
  const cols = Math.max(1, Math.floor(columns) || 1)
  const nonEmpty = groups.map((n, g) => (n > 0 ? g : -1)).filter((g) => g >= 0)
  if (nonEmpty.length === 0) return null
  const first = nonEmpty[0]
  const lastG = nonEmpty[nonEmpty.length - 1]
  if (key === 'Home') return group === first && index === 0 ? null : { group: first, index: 0 }
  if (key === 'End') {
    const idx = groups[lastG] - 1
    return group === lastG && index === idx ? null : { group: lastG, index: idx }
  }
  const n = groups[group] ?? 0
  if (n <= 0) return null
  const inner = rovingStep({ count: n, index, key, columns: cols })
  if (inner !== null) return { group, index: inner }
  const prevG = [...nonEmpty].reverse().find((g) => g < group)
  const nextG = nonEmpty.find((g) => g > group)
  const col = index % cols
  switch (key) {
    case 'ArrowRight':
      return index === n - 1 && nextG !== undefined ? { group: nextG, index: 0 } : null
    case 'ArrowLeft':
      return index === 0 && prevG !== undefined ? { group: prevG, index: groups[prevG] - 1 } : null
    case 'ArrowDown':
      return nextG !== undefined ? { group: nextG, index: Math.min(groups[nextG] - 1, col) } : null
    case 'ArrowUp': {
      if (prevG === undefined) return null
      const count = groups[prevG]
      const lastRowStart = Math.floor((count - 1) / cols) * cols
      return { group: prevG, index: Math.min(count - 1, lastRowStart + col) }
    }
    default:
      return null
  }
}
