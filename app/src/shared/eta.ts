import { tr } from './locale'
// 分析進度 ETA（shared）：main／renderer 共用的純函式。
// 字串為本檔既定介面（`formatEta(ms): '約剩 6 分' | '不到 1 分'`，brief 明定）。

/** 已耗時不足此值（毫秒）時樣本太少，不顯示 ETA（避免「剛看到 50% ⇒ ETA 0」這類假數字） */
export const MIN_ELAPSED_MS = 3000

/**
 * 依目前進度與已耗時（`now - analyzingSince`，起點由 main 在分析開始時記錄）估計剩餘毫秒。
 * - `progress < 0.02` 或 `elapsedMs < 3000`：樣本不足回傳 null；完成（≥1）為 0。
 * - 公式：`elapsedMs * (1 - progress) / progress`。
 * - 無效輸入（NaN／負耗時）回傳 null。
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

/** 將剩餘毫秒格式化為繁中字串：四捨五入到分鐘，不足 1 分（含 0／無效值）為「不到 1 分」。 */
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
