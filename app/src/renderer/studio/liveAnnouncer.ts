/**
 * Throttled aria-live announcements: send the first immediately; keep only the last message during the interval and send it when the interval ends.
 * Used for keyboard-driven playhead/zoom changes to avoid flooding screen readers.
 */
export interface Announcer {
  announce: (msg: string) => void
  dispose: () => void
}

export function createAnnouncer(set: (msg: string) => void, gapMs = 800): Announcer {
  let lastAt = -Infinity
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    timer = null
    if (pending === null) return
    const m = pending
    pending = null
    lastAt = Date.now()
    set(m)
  }

  return {
    announce(msg) {
      const wait = lastAt + gapMs - Date.now()
      if (wait <= 0 && timer === null) {
        lastAt = Date.now()
        set(msg)
        return
      }
      pending = msg
      if (timer === null) timer = setTimeout(flush, Math.max(0, wait))
    },
    dispose() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = null
    }
  }
}
