/** IPC handler for proxy:generate (accepts fake sender/generateProxy dependencies for tests). */
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

/** Accept only finite positive values; treat others as unknown duration (do not show a percentage). */
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
    // Always send completion (1); throttle other updates.
    if (ratio < 1 && t - lastSent < PROXY_PROGRESS_INTERVAL_MS) return
    if (sender.isDestroyed()) return
    lastSent = t
    try {
      sender.send('proxy:progress', { videoPath, ratio })
    } catch {
      // Ignore the send if the window was destroyed at that moment.
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
  /** File size in bytes; return null when the file does not exist. */
  statSize: (file: string) => number | null
}

/** "Proxy disk usage" for Settings: count only proxies for the supplied videos (same scope as `proxy:delete`). */
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
