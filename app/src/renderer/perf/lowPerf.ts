// Single source of truth for low-performance mode: <html data-lowperf> for CSS and subscribers for canvas or other JS consumers.

/** Fixed number of timeline heat-bar bins in low-performance mode. */
export const HEAT_BINS_LOWPERF = 60

interface AttrTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

let root: AttrTarget | null = typeof document !== 'undefined' ? document.documentElement : null
let on = false
const listeners = new Set<(v: boolean) => void>()

/** Bind the root element that receives data-lowperf (defaults to document.documentElement; tests can pass a fake object). */
export function bindLowPerfRoot(r: AttrTarget | null): void {
  root = r
  apply()
}

function apply(): void {
  if (!root) return
  if (on) root.setAttribute('data-lowperf', '')
  else root.removeAttribute('data-lowperf')
}

export function isLowPerf(): boolean {
  return on
}

export function setLowPerf(v: boolean): void {
  if (v === on) {
    apply()
    return
  }
  on = v
  apply()
  listeners.forEach((l) => l(on))
}

export function subscribeLowPerf(cb: (v: boolean) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Heat-bar bins: normal mode uses pixel width (4 px per bin in density mode, 6 px in event mode); low-performance mode always uses 60. */
export function heatBinCount(width: number, density: boolean, lowPerf: boolean): number {
  if (width <= 0) return 0
  return lowPerf ? HEAT_BINS_LOWPERF : Math.ceil(width / (density ? 4 : 6))
}

interface SettingsApi {
  settings?: {
    get?: () => Promise<unknown>
    onChanged?: (cb: (s: unknown) => void) => () => void
  }
}

const flagOf = (s: unknown): boolean | undefined => {
  const v = (s as { lowPerfMode?: unknown } | null)?.lowPerfMode
  return typeof v === 'boolean' ? v : undefined
}

/** Read settings.lowPerfMode on startup and update data-lowperf immediately on settings:changed; return an unsubscribe function. */
export function watchLowPerfSetting(api: SettingsApi | undefined): () => void {
  if (!api?.settings) return () => {}
  let alive = true
  let changed = false
  const off = api.settings.onChanged?.((s) => {
    const v = flagOf(s)
    if (!alive || v === undefined) return
    changed = true
    setLowPerf(v)
  })
  void (async () => {
    try {
      const v = flagOf(await api.settings!.get?.())
      if (alive && !changed && v !== undefined) setLowPerf(v)
    } catch {
      /* If settings cannot be read, keep the current state. */
    }
  })()
  return () => {
    alive = false
    off?.()
  }
}
