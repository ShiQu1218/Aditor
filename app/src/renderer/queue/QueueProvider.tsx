import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { createQueueStore, type QueueStore } from './queueStore'
import type { QueueItemState, QueuePayload, QueueSummary } from '../../shared/queueState'
import { library500Requested } from '../dev/libraryFixtureFlag'

/** Empty store for use outside the Provider (for example, in a separately mounted component); always reports no queue. */
const fallbackStore = createQueueStore()
const QueueContext = createContext<QueueStore>(fallbackStore)

/**
 * Global analysis-queue Context (mounted once by App): subscribe to main's throttled `library:updated` events, which include queue state,
 * and load the initial value with `queue:getState` on mount. The Context value is a stable store,
 * so progress updates do not rerender the Provider subtree (components subscribe through selectors).
 */
export function QueueProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const store = useMemo(() => createQueueStore(), [])

  useEffect(() => {
    if (library500Requested()) {
      let cancelled = false
      void import('../dev/libraryFixture').then((m) => {
        if (!cancelled) store.set(m.makeQueueFixture())
      })
      return () => {
        cancelled = true
      }
    }
    let alive = true
    let received = false
    const off = window.api?.library?.onUpdated?.((payload?: QueuePayload) => {
      if (payload && payload.queue) {
        received = true
        store.set(payload)
      }
    })
    void Promise.resolve(window.api?.queue?.getState?.()).then((payload: QueuePayload | undefined) => {
      // If an event arrived first, do not overwrite it with the older initial value.
      if (alive && !received && payload && payload.queue) store.set(payload)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [store])

  return <QueueContext.Provider value={store}>{children}</QueueContext.Provider>
}

export function useQueueStore(): QueueStore {
  return useContext(QueueContext)
}

/** Queue summary (for the queue strip and popover; queue updates rerender components using it). */
export function useQueueSummary(): QueueSummary {
  const store = useQueueStore()
  return useSyncExternalStore(store.subscribe, store.getSummary, store.getSummary)
}

/** Queue state for one video (a primitive value; rerender only when this video's state changes). */
export function useQueueItemState(path: string): QueueItemState {
  const store = useQueueStore()
  return useSyncExternalStore(store.subscribe, () => store.stateOf(path), () => store.stateOf(path))
}

/** ETA for one video, sourced from the same store as the queue strip and popover. */
export function useQueueEta(path: string): number | null {
  const store = useQueueStore()
  return useSyncExternalStore(store.subscribe, () => store.etaOf(path), () => store.etaOf(path))
}
