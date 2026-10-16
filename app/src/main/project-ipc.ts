import { ProjectStore, StoredProject } from './projects'
import type { SettingsStore } from './settings'

/** ipcMain 的最小子集（方便測試注入）。 */
export interface IpcLike {
  handle(channel: string, fn: (event: any, ...args: any[]) => unknown): void
  on(channel: string, fn: (event: any, ...args: any[]) => void): void
}

/**
 * 專案 IPC：`projects:save`（async）與 `projects:flushSync`（關閉視窗時 renderer 以 sendSync 呼叫，
 * 回傳前已寫入磁碟）。兩者都在**同一次呼叫內**把 `lastProjectId` 記進設定，
 * 所以關閉前最後一次寫入也能在下次啟動還原。
 */
export function registerProjectHandlers(
  ipc: IpcLike,
  store: ProjectStore,
  settings?: SettingsStore,
  onFlushDone?: () => void
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

  ipc.on('projects:flushDone', () => onFlushDone?.())

  ipc.handle('projects:load', async (_e, id: string) => store.load(id))
  // 啟動還原遇到損毀／過新版本時，renderer 用它顯示 notice（I12）
  ipc.handle('projects:lastError', async () =>
    store.lastErrorKind && store.lastError ? { kind: store.lastErrorKind, message: store.lastError } : null
  )
  ipc.handle('projects:list', async () => store.list())
  ipc.handle('projects:remove', async (_e, id: string) => {
    await store.remove(id)
    return true
  })
}

export interface CloseGateOptions {
  /** 請 renderer 立刻 flush（送 `projects:flushRequest`）。 */
  request: () => void
  /** 真正關閉視窗。 */
  close: () => void
  /** renderer 沒回應時最多等多久（ms）。 */
  timeoutMs: number
  /** renderer 已毀損／崩潰時直接放行。 */
  rendererAlive?: () => boolean
}

/**
 * 視窗 `close` 事件的握手：第一次 close 先擋下並要求 renderer flush，
 * 收到 ack（`projects:flushDone`）或逾時才真正關閉；關閉觸發的第二次 close 放行。
 */
export function createCloseGate(opts: CloseGateOptions): {
  onClose: (e: { preventDefault(): void }) => void
  ack: () => void
} {
  let state: 'idle' | 'waiting' | 'done' = 'idle'
  let timer: ReturnType<typeof setTimeout> | null = null

  const finish = (): void => {
    if (state !== 'waiting') return
    state = 'done'
    if (timer) clearTimeout(timer)
    timer = null
    opts.close()
  }

  return {
    onClose(e) {
      if (state === 'done') return
      if (opts.rendererAlive && !opts.rendererAlive()) return
      e.preventDefault()
      if (state === 'waiting') return
      state = 'waiting'
      timer = setTimeout(finish, opts.timeoutMs)
      opts.request()
    },
    ack: finish
  }
}
