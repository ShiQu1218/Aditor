/**
 * 專案片段卡的來源色點（Task 13）：
 * 依 `sources` 陣列順序穩定指派 A、B、…（第 27 個繞回 A）；色盤 6 色循環。
 * 不在清單中的來源退回第一格（實務上 `sources` 由專案片段推得，必含來源）。
 */

const PALETTE = 6

export interface SourceBadge {
  letter: string
  colorVar: string
}

export function sourceBadge(path: string, sources: string[]): SourceBadge {
  const at = sources.indexOf(path)
  const index = at >= 0 ? at : 0
  return {
    letter: String.fromCharCode(65 + (index % 26)),
    colorVar: `var(--src-${(index % PALETTE) + 1})`
  }
}
