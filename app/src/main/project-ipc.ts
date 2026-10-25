import { ProjectStore, StoredProject } from './projects'
import type { SettingsStore } from './settings'

/** Minimal ipcMain subset (for dependency injection in tests). */
export interface IpcLike {
  handle(channel: string, fn: (event: any, ...args: any[]) => unknown): void
  on(channel: string, fn: (event: any, ...args: any[]) => void): void
}

/**
 * Project IPC: `projects:save` (async) and `projects:flushSync` (called by the renderer with sendSync when closing a window,
 * and writes to disk before returning). Both update `lastProjectId` in settings in the same call,
 * so the most recent save before closing can be restored at the next startup.
 */
export function registerProjectHandlers(
  ipc: IpcLike,
  store: ProjectStore,
  settings?: SettingsStore,
  onFlushDone?: (ok: boolean) => void
): void {
  const remember = (id: string): void => {
    try {
      if (settings && settings.get().lastProjectId !== id) settings.set({ lastProjectId: id })
    } catch (err) {
      console.error('[Projects] failed to record lastProjectId:', err)
    }
  }

  ipc.handle('projects:save', async (_e, p: StoredProject) => {
    await store.save(p)
    remember(p.id)
    return true
  })

  ipc.on('projects:flushSync', (event, p: StoredProject) => {
    try {
      store.saveSync(p)
      remember(p.id)
      event.returnValue = true
    } catch (err) {
      console.error('[Projects] flushSync failed:', err)
      event.returnValue = false
    }
  })

  ipc.on('projects:flushDone', (_event, ok?: boolean) => onFlushDone?.(ok !== false))

  // Loading counts as opening: remember the id so the next startup restores the project the user last worked in.
  ipc.handle('projects:load', async (_e, id: string) => {
    const project = await store.load(id)
    if (project) remember(id)
    return project
  })
  // Used by the renderer to show a notice when startup restore finds a corrupt or newer-version project (I12).
  ipc.handle('projects:lastError', async () =>
    store.lastErrorKind && store.lastError ? { kind: store.lastErrorKind, message: store.lastError } : null
  )
  ipc.handle('projects:list', async () => store.list())
  ipc.handle('projects:rename', async (_e, id: string, name: string) => store.rename(id, name))
  ipc.handle('projects:remove', async (_e, id: string) => {
    await store.remove(id)
    return true
  })
}

export interface CloseGateOptions {
  /** Ask the renderer to flush immediately (send `projects:flushRequest`). */
  request: () => void
  /** Actually close the window. */
  close: () => void
  /** Maximum wait (ms) when the renderer does not respond. */
  timeoutMs: number
  /** Allow the close immediately if the renderer is destroyed/crashed. */
  rendererAlive?: () => boolean
  /** Whether the app is quitting: deferring close cancels Electron quit, so continue quitting after flush completes. */
  isQuitting?: () => boolean
  quit?: () => void
}

/**
 * Handshake for the window `close` event: prevent the first close and ask the renderer to flush;
 * close after receiving an ack (`projects:flushDone`) or timing out; allow the second close triggered by the actual close.
 */
export function createCloseGate(opts: CloseGateOptions): {
  onClose: (e: { preventDefault(): void }) => void
  ack: (ok?: boolean) => void
} {
  let state: 'idle' | 'waiting' | 'done' = 'idle'
  let timer: ReturnType<typeof setTimeout> | null = null
  let quittingOnClose = false

  const finish = (): void => {
    if (state !== 'waiting') return
    state = 'done'
    if (timer) clearTimeout(timer)
    timer = null
    const shouldQuit = quittingOnClose || Boolean(opts.isQuitting?.())
    opts.close()
    if (shouldQuit) opts.quit?.()
  }

  return {
    onClose(e) {
      if (state === 'done') return
      if (opts.rendererAlive && !opts.rendererAlive()) return
      e.preventDefault()
      if (opts.isQuitting?.()) quittingOnClose = true
      if (state === 'waiting') return
      state = 'waiting'
      timer = setTimeout(finish, opts.timeoutMs)
      opts.request()
    },
    ack(ok = true) {
      if (ok) finish()
      else if (state === 'waiting') {
        if (timer) clearTimeout(timer)
        timer = null
        state = 'idle'
      }
    }
  }
}
