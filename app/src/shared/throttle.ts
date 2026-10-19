/**
 * Throttle (leading + trailing): the first call outside the window fires immediately; calls inside the window are
 * combined into one call at the end, so the last update is always delivered and calls are at least ms apart.
 * main uses this to limit `library:updated` broadcasts (500 ms). It uses `Date.now()`, so tests can use fake timers.
 */
export interface Throttle {
  trigger(): void
  /** Immediately fire a pending trailing call, if any. */
  flush(): void
  /** Discard a pending trailing call. */
  cancel(): void
}

export function createThrottle(fn: () => void, ms: number): Throttle {
  let lastFire = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null

  const fire = (): void => {
    lastFire = Date.now()
    fn()
  }
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    trigger() {
      if (timer) return // A trailing call is already scheduled; merge this call into it.
      const wait = lastFire + ms - Date.now()
      if (wait <= 0) {
        fire()
        return
      }
      timer = setTimeout(() => {
        timer = null
        fire()
      }, wait)
    },
    flush() {
      if (!timer) return
      clear()
      fire()
    },
    cancel: clear
  }
}
