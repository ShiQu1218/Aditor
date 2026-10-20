import { useEffect, useState } from 'react'
import type { Settings } from '../../shared/settings'

interface SettingsApiLike {
  get?(): Promise<Settings>
  onChanged?(cb: (s: Settings) => void): () => void
}

/**
 * Settings snapshot for the shell: read once at startup and subscribe to `settings:changed`.
 * Return null until loaded or when IPC is unavailable (for example, in an individually mounted screen).
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
