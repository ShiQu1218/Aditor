// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanupMounted, mount } from '../../../test/dom'
import { createQueueStore } from '../queue/queueStore'
import { QueueRing } from './QueueRing'

const state = vi.hoisted(() => ({ store: null as ReturnType<typeof createQueueStore> | null }))
vi.mock('../queue/QueueProvider', () => ({ useQueueStore: () => state.store }))
afterEach(() => { cleanupMounted(); vi.restoreAllMocks() })

test('Queue icon shows progress when tasks arrive, returns to idle when cleared, and unsubscribes on unmount', () => {
  const store = createQueueStore()
  state.store = store
  const unsubscribe = vi.fn()
  const subscribe = store.subscribe.bind(store)
  vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
    const off = subscribe(listener)
    return () => { off(); unsubscribe() }
  })
  mount(<QueueRing />)
  const icon = document.querySelector<HTMLElement>('.queue-indicator')!
  expect(icon.dataset.active).toBe('false')
  expect(icon.querySelector('.app-icon-analysis-queue')).not.toBeNull()
  act(() => store.set({
    queue: { analyzing: 'clip.mp4', queued: [] },
    current: { path: 'clip.mp4', progress: 0.42, analyzingSince: null }
  }))
  expect(icon.dataset.active).toBe('true')
  expect(icon.style.getPropertyValue('--p')).toBe('42')
  act(() => store.set(null))
  expect(icon.dataset.active).toBe('false')
  expect(icon.style.getPropertyValue('--p')).toBe('0')
  cleanupMounted()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
