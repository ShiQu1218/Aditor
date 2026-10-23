import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

type FlushResult = void | boolean | PromiseLike<unknown>
type ProjectsApi = {
  onFlushRequest(callback: () => FlushResult): () => void
}

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn()
  },
  webUtils: { getPathForFile: vi.fn() }
}))
vi.mock('electron', () => electron)

let projects!: ProjectsApi
const cleanups: Array<() => void> = []

beforeAll(async () => {
  const oldIsolated = process.contextIsolated
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  try {
    await import('./index')
    const exposed = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as { projects: ProjectsApi }
    projects = exposed.projects
  } finally {
    Object.defineProperty(process, 'contextIsolated', { value: oldIsolated, configurable: true })
  }
})

afterEach(() => {
  for (const off of cleanups.splice(0)) off()
  vi.clearAllMocks()
})

function subscribe(callback: () => FlushResult): void {
  cleanups.push(projects.onFlushRequest(callback))
}

function flushHandler(): () => void {
  const registrations = electron.ipcRenderer.on.mock.calls.filter(([channel]) => channel === 'projects:flushRequest')
  const handler = registrations[registrations.length - 1]?.[1]
  expect(handler).toBeTypeOf('function')
  return handler as () => void
}

describe('preload project flush aggregation', () => {
  test('sends one failed acknowledgement when any callback returns false', () => {
    subscribe(() => true)
    subscribe(() => false)

    flushHandler()()

    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('projects:flushDone', false)
  })

  test('turns a callback exception into one failed acknowledgement', () => {
    subscribe(() => { throw new Error('save failed') })

    flushHandler()()

    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('projects:flushDone', false)
  })

  test('unsubscribes the shared listener and acknowledges a normal true flush', () => {
    const off = projects.onFlushRequest(() => true)
    const handler = flushHandler()
    off()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith('projects:flushRequest', handler)

    subscribe(() => true)
    flushHandler()()
    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('projects:flushDone', true)
  })

  test('treats a rejected PromiseLike as failed and handles its rejection', async () => {
    let reject!: (reason: unknown) => void
    const pending = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise })
    subscribe(() => pending)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      flushHandler()()
      expect(electron.ipcRenderer.send).toHaveBeenCalledWith('projects:flushDone', false)
      reject(new Error('async save failed'))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.removeListener('unhandledRejection', unhandled)
    }
  })
})
