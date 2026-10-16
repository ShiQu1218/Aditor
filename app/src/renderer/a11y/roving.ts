// roving tabindex 的鍵盤移動規則（純函式）：網格／清單／軌道共用。

export type RovingOrientation = 'grid' | 'vertical' | 'horizontal'

export interface RovingParams {
  /** 項目總數 */
  count: number
  /** 目前游標索引（-1＝尚無游標） */
  index: number
  key: string
  /** 網格欄數（直向清單給 1） */
  columns: number
  /** grid＝四向；vertical＝只回應 ↑↓；horizontal＝只回應 ←→（預設 grid） */
  orientation?: RovingOrientation
}

/**
 * 回傳按鍵後的新游標索引；不處理的鍵或已在邊界（無移動）回 null。
 * ←→ 移一格；↑↓ 移一整列（落在較短的最後一列時停在最後一項）；Home／End 到頭尾。不環繞。
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
      else if (Math.floor(from / step) < Math.floor(last / step)) next = last // 下一列較短
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
  /** 各日期分組的項目數 */
  groups: number[]
  group: number
  index: number
  key: string
  columns: number
}

/**
 * 影片庫網格（日期分組）的游標移動：組內用 rovingStep；
 * ←→ 與 ↑↓ 在組界上延伸到相鄰的非空分組（↑↓ 保持欄位並夾在該列範圍內）；Home／End 為整個網格的頭尾。
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
