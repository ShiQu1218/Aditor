/**
 * Source color dots for project clip cards (Task 13):
 * Assign A, B, … in stable `sources` array order (the 27th wraps to A); cycle through the six-color palette.
 * Sources absent from the list fall back to the first color (in practice, `sources` comes from project clips and includes each source).
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
