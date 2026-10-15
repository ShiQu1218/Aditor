import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { createQueueStore, type QueueStore } from './queueStore'
import type { QueueItemState, QueuePayload, QueueSummary } from '../../shared/queueState'
import { library500Requested, makeQueueFixture } from '../dev/libraryFixture'

/** Provider 之外（例如單獨掛載的元件）使用的空 store：永遠是「沒有佇列」 */
const fallbackStore = createQueueStore()
const QueueContext = createContext<QueueStore>(fallbackStore)

/**
 * 全域分析佇列 Context（App 只掛一個）：訂閱 main 的 `library:updated`（夾帶佇列狀態，已節流）
 * 並在掛載時以 `queue:getState` 補初始值；Context 值是穩定的 store，
 * 進度更新不會讓 Provider 的子樹重新渲染（各元件用 selector 訂閱）。
 */
export function QueueProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const store = useMemo(() => createQueueStore(), [])

  useEffect(() => {
    if (library500Requested()) {
      store.set(makeQueueFixture())
      return
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
      // 事件已先到的話，不用較舊的初始值覆蓋
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

/** 佇列摘要（佇列條、浮層用；每次佇列更新都會重繪使用它的元件） */
export function useQueueSummary(): QueueSummary {
  const store = useQueueStore()
  return useSyncExternalStore(store.subscribe, store.getSummary)
}

/** 單一影片的佇列狀態（原始值：只有自己的狀態改變時才重繪） */
export function useQueueItemState(path: string): QueueItemState {
  const store = useQueueStore()
  return useSyncExternalStore(store.subscribe, () => store.stateOf(path))
}

/** 單一影片的 ETA（與佇列條、浮層同一個來源，數字一致） */
export function useQueueEta(path: string): number | null {
  const store = useQueueStore()
  return useSyncExternalStore(store.subscribe, () => store.etaOf(path))
}
