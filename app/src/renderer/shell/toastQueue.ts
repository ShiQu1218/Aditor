// Toast 佇列：最多同時顯示 max 則，超過丟最舊；支援暫停／續算計時
export type Toast = {
  id: string
  message: string
  action?: { label: string; run: () => void }
  ttlMs: number
}

type Listener = (toasts: Toast[]) => void
type Timer = { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }

export const defaultTtl = (hasAction: boolean): number => (hasAction ? 6000 : 3800)

export function createToastQueue(max = 3) {
  let toasts: Toast[] = []
  const timers = new Map<string, Timer>()
  const listeners = new Set<Listener>()

  const emit = () => listeners.forEach((l) => l(toasts))

  const clearTimer = (id: string) => {
    const tm = timers.get(id)
    if (tm?.handle) clearTimeout(tm.handle)
    timers.delete(id)
  }

  const dismiss = (id: string): void => {
    if (!toasts.some((x) => x.id === id)) return
    clearTimer(id)
    toasts = toasts.filter((x) => x.id !== id)
    emit()
  }

  const start = (id: string, remaining: number) => {
    const tm: Timer = { handle: null, remaining, startedAt: Date.now() }
    tm.handle = setTimeout(() => dismiss(id), remaining)
    timers.set(id, tm)
  }

  return {
    push(t: Toast): Toast[] {
      if (toasts.some((x) => x.id === t.id)) clearTimer(t.id)
      toasts = [...toasts.filter((x) => x.id !== t.id), t]
      while (toasts.length > max) {
        clearTimer(toasts[0].id)
        toasts = toasts.slice(1)
      }
      start(t.id, t.ttlMs)
      emit()
      return toasts
    },
    dismiss,
    pause(id: string): void {
      const tm = timers.get(id)
      if (!tm || !tm.handle) return
      clearTimeout(tm.handle)
      tm.handle = null
      tm.remaining = Math.max(0, tm.remaining - (Date.now() - tm.startedAt))
    },
    resume(id: string): void {
      const tm = timers.get(id)
      if (!tm || tm.handle) return
      start(id, tm.remaining)
    },
    list: (): Toast[] => toasts,
    subscribe(l: Listener): () => void {
      listeners.add(l)
      return () => { listeners.delete(l) }
    }
  }
}

export type ToastQueue = ReturnType<typeof createToastQueue>
