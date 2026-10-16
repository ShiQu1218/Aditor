/**
 * 結束 App 前先等背景工作收尾（I7）：進行中的匯出／代理檔 ffmpeg 要被終止、半成品要刪除，
 * 引擎要停止。Windows 不會在主程序結束時連帶殺掉子程序，所以不能只送出取消就退出。
 * 第一次 before-quit 會被擋下，等所有任務完成（或逾時）後再真正退出。
 */
export interface QuitGuardOptions {
  tasks: Array<() => Promise<unknown> | undefined | void>
  quit: () => void
  timeoutMs: number
}

export function createQuitGuard(opts: QuitGuardOptions): { onBeforeQuit: (e: { preventDefault(): void }) => void } {
  let state: 'idle' | 'running' | 'done' = 'idle'
  return {
    onBeforeQuit(e) {
      if (state === 'done') return
      e.preventDefault()
      if (state === 'running') return
      state = 'running'
      const all = Promise.allSettled(
        opts.tasks.map(async (t) => {
          try {
            await t()
          } catch {
            // 單一任務失敗不能擋住退出
          }
        })
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((r) => {
        timer = setTimeout(r, opts.timeoutMs)
      })
      void Promise.race([all, timeout]).then(() => {
        if (timer) clearTimeout(timer)
        state = 'done'
        opts.quit()
      })
    }
  }
}
