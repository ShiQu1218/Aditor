/**
 * Wait for background work to finish before quitting the app (I7): terminate active export/proxy ffmpeg processes, remove partial files,
 * and stop the engine. Windows does not kill child processes when the main process exits, so do not quit immediately after sending cancellation.
 * Prevent the first before-quit event, then quit after all tasks finish (or time out).
 *
 * Recording finalization (closing the recorder, segment finalization and FFmpeg remux) is unbounded work: a fixed timeout can cut it off
 * midway and leave `.part` files or an unregistered recording. Such work belongs in `criticalTasks`, which have no timeout and are awaited
 * before the ordinary cleanup below. Erroring critical tasks count as finished so a crash cannot trap the app in a quitting state.
 *
 * Independent cancellation (export/proxy ffmpeg, folder watching) can start immediately through `earlyTasks` so a long remux does not keep
 * unrelated resources alive; `tasks` then start after finalization and get their own full timeout.
 */
export interface QuitGuardOptions {
  /** Cleanup that may start immediately while critical work is still in progress. Still awaited before quitting. */
  earlyTasks?: Array<() => Promise<unknown> | undefined | void>
  /** Cleanup that is allowed to time out, run after every critical task has settled. Required; pass an empty array when unused. */
  tasks: Array<() => Promise<unknown> | undefined | void>
  /** Work that must settle before quitting (for example recording finalization/remux). No timeout is applied. */
  criticalTasks?: Array<() => Promise<unknown> | undefined | void>
  quit: () => void
  timeoutMs: number
}

export interface QuitGuard {
  onBeforeQuit(e: { preventDefault(): void }): void
}

const run = async (task: () => Promise<unknown> | undefined | void): Promise<void> => {
  try {
    await task()
  } catch {
    // A single task failure or rejection must not block quitting.
  }
}

export function createQuitGuard(opts: QuitGuardOptions): QuitGuard {
  let state: 'idle' | 'running' | 'done' = 'idle'
  return {
    onBeforeQuit(e) {
      if (state === 'done') return
      e.preventDefault()
      if (state === 'running') return
      state = 'running'
      void (async () => {
        // Export/proxy cancellation and folder watching do not depend on recording finalization; let them overlap a long remux.
        const early = Promise.all((opts.earlyTasks ?? []).map(run))
        const criticalTasks = opts.criticalTasks ?? []
        if (criticalTasks.length) await Promise.all(criticalTasks.map(run))
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const all = Promise.all([early, ...opts.tasks.map(run)])
          const timeout = new Promise<void>((r) => {
            timer = setTimeout(r, opts.timeoutMs)
          })
          await Promise.race([all, timeout])
        } finally {
          if (timer) clearTimeout(timer)
          // Set done before quit() so the before-quit event it emits passes through instead of re-entering the guard.
          state = 'done'
          opts.quit()
        }
      })()
    }
  }
}

/** Main-process wiring for the quit guard: recording finalization is critical, while everything else keeps the bounded timeout. */
export interface AppQuitGuardDeps {
  stopRecording: () => Promise<unknown> | undefined | void
  flushLibrary: () => void
  stopEngine: () => Promise<unknown> | undefined | void
  cancelExport: () => Promise<unknown> | undefined | void
  cancelProxies: () => Promise<unknown> | undefined | void
  stopWatcher: () => void
  /** Start a manually requested update after finalization; return true when it has taken over quitting. */
  installUpdate?: () => boolean
  quit: () => void
  timeoutMs: number
}

export function createAppQuitGuard(deps: AppQuitGuardDeps): QuitGuard {
  return createQuitGuard({
    // These do not wait for the recording; stopping them early prevents unrelated ffmpeg work and watcher events during a long remux.
    earlyTasks: [
      () => deps.cancelExport(),
      () => deps.cancelProxies(),
      () => deps.stopWatcher(),
      // Persist pending library changes immediately; entries added by finalization are flushed again after recording stop.
      () => deps.flushLibrary()
    ],
    criticalTasks: [
      async () => {
        try {
          await deps.stopRecording()
        } finally {
          // Finalization adds library entries even when stopping fails partway; persist them before the bounded cleanup starts.
          deps.flushLibrary()
        }
      }
    ],
    // The engine is stopped after recording finalization, and its timeout starts here rather than while waiting for the remux.
    tasks: [() => deps.stopEngine()],
    quit: () => {
      // A manual update installer replaces Aditor's files and may terminate the process, so spawn it only after every
      // finalization/cleanup step above has settled. Ordinary quits, including after a download, call app.quit() without installing.
      if (!deps.installUpdate?.()) deps.quit()
    },
    timeoutMs: deps.timeoutMs
  })
}
