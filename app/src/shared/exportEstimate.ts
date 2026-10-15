/** 匯出大小粗估（純函式，供匯出抽屜與 main 的磁碟空間檢查共用）。 */
export type ExportQuality = 'copy' | 'precise'

export interface EstimateItem {
  start: number
  end: number
}

/** 位元率假設：複製＝保留原畫質（約 30 Mbps）；精準轉碼＝約 12 Mbps。 */
export const COPY_BYTES_PER_SECOND = (30 * 1024 * 1024) / 8
export const PRECISE_BYTES_PER_SECOND = (12 * 1024 * 1024) / 8

export function estimateOutputBytes(project: { items: EstimateItem[] }, quality: ExportQuality): number {
  let totalDur = 0
  for (const item of project.items) {
    const d = item.end - item.start
    if (Number.isFinite(d) && d > 0) totalDur += d
  }
  const bps = quality === 'copy' ? COPY_BYTES_PER_SECOND : PRECISE_BYTES_PER_SECOND
  return Math.ceil(totalDur * bps)
}
