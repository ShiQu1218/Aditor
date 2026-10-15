// 分析進度 ETA（shared）：main／renderer 共用的純函式。
// 字串為本檔既定介面（`formatEta(ms): '約剩 6 分' | '不到 1 分'`，brief 明定）。

/**
 * 依目前進度與已耗時估計剩餘毫秒。
 * - `progress < 0.02`：樣本不足回傳 null；完成（≥1）為 0。
 * - 公式：`elapsedMs * (1 - progress) / progress`。
 * - 無效輸入（NaN／負耗時）回傳 null。
 */
export function estimateEta(progress: number, elapsedMs: number): number | null {
  if (!Number.isFinite(progress) || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return null
  }
  if (progress < 0.02) {
    return null
  }
  if (progress >= 1) {
    return 0
  }
  return (elapsedMs * (1 - progress)) / progress
}

/** 將剩餘毫秒格式化為繁中字串：四捨五入到分鐘，不足 1 分（含 0／無效值）為「不到 1 分」。 */
export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '不到 1 分'
  }
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) {
    return '不到 1 分'
  }
  return `約剩 ${minutes} 分`
}

export interface EtaTrackInput {
  path: string
  status: string
  progress: number
}

/**
 * 追蹤各影片「首次以 analyzing 身分出現」的時間（`state` 內以 path → startedAt 保存），
 * 回傳 path → ETA（毫秒或 null）。非 analyzing 的項目會被清除。
 * 由 renderer 的 `useEtaTracker` 每次渲染呼叫；本函式為純函式，可直接測試。
 */
export function trackEta(
  state: Map<string, number>,
  entries: readonly EtaTrackInput[],
  now: number
): Map<string, number | null> {
  const result = new Map<string, number | null>()
  const alive = new Set<string>()
  for (const entry of entries) {
    if (entry.status !== 'analyzing') {
      continue
    }
    alive.add(entry.path)
    let startedAt = state.get(entry.path)
    if (startedAt === undefined) {
      startedAt = now
      state.set(entry.path, now)
    }
    result.set(entry.path, estimateEta(entry.progress, Math.max(0, now - startedAt)))
  }
  for (const key of [...state.keys()]) {
    if (!alive.has(key)) {
      state.delete(key)
    }
  }
  return result
}
