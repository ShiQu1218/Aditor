import { useEffect, useState } from 'react'
import type { Settings } from '../../shared/settings'

interface SettingsApiLike {
  get?(): Promise<Settings>
  onChanged?(cb: (s: Settings) => void): () => void
}

/**
 * 殼層用的設定快照：啟動時讀一次並訂閱 `settings:changed`。
 * 尚未讀到（或 IPC 不可用，例如單獨掛載的畫面）時回傳 null。
 */
export function useAppSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    const api = (window as unknown as { api?: { settings?: SettingsApiLike } }).api?.settings
    if (!api) return
    let alive = true
    const off = api.onChanged?.((s) => { if (alive) setSettings(s) })
    void Promise.resolve(api.get?.())
      .then((s) => { if (alive && s) setSettings((cur) => cur ?? s) })
      .catch(() => undefined)
    return () => {
      alive = false
      off?.()
    }
  }, [])
  return settings
}
