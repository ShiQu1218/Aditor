// Today/yesterday labels expire at local midnight: provide milliseconds until the next local midnight and a hook to refresh the current time.
import { useEffect, useState } from 'react'

/** Milliseconds until the next local midnight (at least 1 to avoid a 0 ms timer loop). */
export function msUntilNextLocalMidnight(now: number): number {
  const d = new Date(now)
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return Math.max(1, next - now)
}

function dayId(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** Return the current time; update at local midnight (timer) and when the window regains focus (timers may be missed during system sleep). Stable within the same day. */
export function useLocalNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      const t = Date.now()
      setNow((prev) => (dayId(prev) === dayId(t) ? prev : t))
    }
    const schedule = (): void => {
      timer = setTimeout(() => {
        refresh()
        schedule()
      }, msUntilNextLocalMidnight(Date.now()) + 50)
    }
    schedule()
    window.addEventListener('focus', refresh)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return now
}
