/**
 * Wait for background work to finish before quitting the app (I7): terminate active export/proxy ffmpeg processes, remove partial files,
 * and stop the engine. Windows does not kill child processes when the main process exits, so do not quit immediately after sending cancellation.
 * Prevent the first before-quit event, then quit after all tasks finish (or time out).
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
            // A single task failure must not block quitting.
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
