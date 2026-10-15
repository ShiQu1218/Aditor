/** proxy:generate 的 IPC 處理本體（可注入假 sender / generateProxy 以便測試）。 */
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
  if (typeof videoPath !== 'string' || videoPath.length === 0) {
    throw new Error('proxy:generate 需要影片路徑字串')
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
