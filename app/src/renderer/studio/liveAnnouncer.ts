/**
 * 限速的 aria-live 播報：第一則立即送出；間隔內的連續訊息只保留最後一則，間隔結束後補送。
 * 供鍵盤驅動的播放頭／縮放變更使用（避免螢幕閱讀器被洗版）。
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
