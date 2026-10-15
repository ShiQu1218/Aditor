/**
 * 節流（前緣＋尾端）：視窗外的第一次呼叫立即送出；視窗內的呼叫合併成一次、在視窗結束時送出，
 * 所以「最後一次更新」一定會送達，且兩次送出間隔不小於 ms。
 * main 用它限制 `library:updated` 廣播（500 ms）。以 `Date.now()` 計時，測試用 fake timers 即可。
 */
export interface Throttle {
  trigger(): void
  /** 若有排隊中的尾端呼叫，立刻送出 */
  flush(): void
  /** 丟棄排隊中的尾端呼叫 */
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
      if (timer) return // 已排尾端：本次合併進去
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
