// 低效能模式的單一狀態來源：<html data-lowperf>（CSS 用）＋ 訂閱者（canvas 等需要 JS 判斷的地方）。

/** 低效能模式的時間軸熱度條固定格數 */
export const HEAT_BINS_LOWPERF = 60

interface AttrTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

let root: AttrTarget | null = typeof document !== 'undefined' ? document.documentElement : null
let on = false
const listeners = new Set<(v: boolean) => void>()

/** 綁定要寫 data-lowperf 的根元素（預設 document.documentElement；測試可傳假物件）。 */
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

/** 熱度條格數：一般模式依像素寬度（密度模式 4 px、事件模式 6 px 一格）；低效能固定 60 格。 */
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

/** 啟動時讀取 settings.lowPerfMode，並隨 settings:changed 即時切換 data-lowperf。回傳解除訂閱。 */
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
      /* 讀不到設定＝維持目前狀態 */
    }
  })()
  return () => {
    alive = false
    off?.()
  }
}
