/** 影片 src 與 seek 規劃（純函式）：換檔後才能套用的時間，不得設在即將被替換的 <video> 上。 */

export function fileUrl(path: string): string {
  return `file://${path.replace(/\\/g, '/')}`
}

/** 要 seek 的檔案已載入 → 立即套用；否則等 loadedmetadata 後套用。 */
export function planSeek(i: { loadedSrc: string | null; wantedSrc: string }): 'now' | 'defer' {
  return i.loadedSrc !== null && i.loadedSrc === i.wantedSrc ? 'now' : 'defer'
}

/**
 * timeupdate 的去向：
 * - 專案預覽中：預覽檔已載入且無待套用 seek → 'preview'（不動來源播放頭）
 * - 來源模式：來源檔已載入且無待套用 seek → 'source'
 * - 其餘（舊影片殘留事件、換檔過渡）→ 'ignore'
 */
export function routeTimeUpdate(i: {
  previewSrc: string | null
  sourceSrc: string
  loadedSrc: string | null
  pending: boolean
}): 'source' | 'preview' | 'ignore' {
  if (i.pending) return 'ignore'
  if (i.previewSrc !== null) return i.loadedSrc === i.previewSrc ? 'preview' : 'ignore'
  return i.loadedSrc === i.sourceSrc ? 'source' : 'ignore'
}
