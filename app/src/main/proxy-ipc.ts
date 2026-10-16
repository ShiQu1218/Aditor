/** proxy:generate 的 IPC 處理本體（可注入假 sender / generateProxy 以便測試）。 */
import { isSafeLocalVideoPath } from './safe-path'

export interface ProgressSender {
  isDestroyed(): boolean
  send(channel: string, data: { videoPath: string; ratio: number }): void
}

export interface ProxyIpcDeps {
  generateProxy: (videoPath: string, onProgress?: (ratio: number) => void, durationSec?: number) => Promise<string>
  now?: () => number
}

export const PROXY_PROGRESS_INTERVAL_MS = 250

/** 只接受有限正數；其餘視為未知長度（不顯示百分比）。 */
export function parseProxyDuration(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

export async function handleProxyGenerate(
  sender: ProgressSender,
  videoPath: unknown,
  durationSec: unknown,
  deps: ProxyIpcDeps
): Promise<string> {
  if (!isSafeLocalVideoPath(videoPath)) {
    throw new Error('proxy:generate 需要本機影片路徑')
  }
  const now = deps.now ?? Date.now
  let finished = false
  let lastSent = -Infinity
  const onProgress = (ratio: number): void => {
    if (finished) return
    const t = now()
    // 完成（1）一律送出，其餘節流
    if (ratio < 1 && t - lastSent < PROXY_PROGRESS_INTERVAL_MS) return
    if (sender.isDestroyed()) return
    lastSent = t
    try {
      sender.send('proxy:progress', { videoPath, ratio })
    } catch {
      // 視窗在送出瞬間被銷毀，忽略
    }
  }
  try {
    return await deps.generateProxy(videoPath, onProgress, parseProxyDuration(durationSec))
  } finally {
    finished = true
  }
}

export interface ProxyUsageDeps {
  proxyPath: (videoPath: string) => string
  /** 檔案大小（bytes）；檔案不存在回 null */
  statSize: (file: string) => number | null
}

/** 設定頁「代理檔佔用空間」：只統計傳入影片各自的代理檔（與 `proxy:delete` 的範圍一致）。 */
export function handleProxyUsage(videoPaths: unknown, deps: ProxyUsageDeps): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  if (!Array.isArray(videoPaths)) return { count, bytes }
  for (const v of videoPaths) {
    if (typeof v !== 'string' || v.length === 0) continue
    const size = deps.statSize(deps.proxyPath(v))
    if (size === null) continue
    count += 1
    bytes += size
  }
  return { count, bytes }
}
