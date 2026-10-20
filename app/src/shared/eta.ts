import { tr } from './locale'
// Analysis progress ETA (shared): pure function used by main and renderer.
// The strings are part of this file's interface (`formatEta(ms): '約剩 6 分' | '不到 1 分'`, as defined in the brief).

/** Show no ETA when elapsed time is below this value (ms), because there is too little data (avoids misleading values like "just saw 50% ⇒ ETA 0"). */
export const MIN_ELAPSED_MS = 3000

/**
 * Estimate remaining milliseconds from current progress and elapsed time (`now - analyzingSince`; main records the start when analysis begins).
 * - `progress < 0.02` or `elapsedMs < 3000`: return null due to insufficient data; complete (>=1) returns 0.
 * - Formula: `elapsedMs * (1 - progress) / progress`.
 * - Invalid input (NaN/negative elapsed time) returns null.
 */
export function estimateEta(progress: number, elapsedMs: number): number | null {
  if (!Number.isFinite(progress) || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return null
  }
  if (progress >= 1) {
    return 0
  }
  if (progress < 0.02 || elapsedMs < MIN_ELAPSED_MS) {
    return null
  }
  return (elapsedMs * (1 - progress)) / progress
}

/** Format remaining milliseconds as a Traditional Chinese string: round to minutes; values under 1 minute (including zero/invalid) return "不到 1 分". */
export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return tr('不到 1 分')
  }
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) {
    return tr('不到 1 分')
  }
  return tr('約剩 {minutes} 分', { minutes })
}
