import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { summarizeQueue, type QueuePayload } from '../../shared/queueState'
import { catalogFor, i18n } from '../i18n'
import { QueueStrip } from './QueueStrip'
import { QueuePopover } from '../shell/QueuePopover'

const state = vi.hoisted(() => ({ payload: null as QueuePayload | null }))
vi.mock('../queue/QueueProvider', () => ({
  useQueueSummary: () => summarizeQueue(state.payload, 0),
  useQueueStore: () => ({ subscribe: () => () => {}, getSummary: () => summarizeQueue(state.payload, 0) })
}))

test('strip and popover show game deferral without analysis progress and retain cancel actions', () => {
  state.payload = { queue: { analyzing: null, queued: ['video.mp4'], waitingForGame: true }, current: null }
  const strip = renderToStaticMarkup(<QueueStrip />)
  const popover = renderToStaticMarkup(<QueuePopover open onClose={() => {}} />)
  expect(strip).toContain(i18n.queue.waitingForGame)
  expect(popover).toContain(i18n.queue.waitingForGame)
  expect(popover).toContain(i18n.queue.cancel)
  expect(strip).not.toContain('0%')
  expect(catalogFor('zh-TW').i18n.queue.waitingForGame).toBe('等待遊戲關閉後分析')
  expect(catalogFor('en').i18n.queue.waitingForGame).toBe('Waiting for the game to close')
  state.payload.queue.waitingForGame = false
  expect(renderToStaticMarkup(<QueueStrip />)).not.toContain(i18n.queue.waitingForGame)
  state.payload.queue.queued = []
  expect(renderToStaticMarkup(<QueueStrip />)).toBe('')
})
