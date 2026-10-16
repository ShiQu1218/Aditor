import { describe, expect, it, vi } from 'vitest'
import { registerProjectHandlers } from './project-ipc'

describe('projects:lastError (I12)', () => {
  it('exposes the store last error kind/message to the renderer', async () => {
    const handlers = new Map<string, (...a: any[]) => unknown>()
    const store = { lastErrorKind: 'corrupt', lastError: '專案檔損毀' } as any
    registerProjectHandlers({ handle: (c, f) => void handlers.set(c, f), on: vi.fn() }, store)
    expect(await handlers.get('projects:lastError')!({})).toEqual({ kind: 'corrupt', message: '專案檔損毀' })
    store.lastErrorKind = null
    store.lastError = null
    expect(await handlers.get('projects:lastError')!({})).toBeNull()
  })
})
