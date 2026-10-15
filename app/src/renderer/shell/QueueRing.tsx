import React, { useEffect, useRef } from 'react'
import { useQueueStore } from '../queue/QueueProvider'

/**
 * 佇列環形進度：conic-gradient 讀 CSS 變數 `--p`（0–100）。
 * 進度更新時直接對 DOM 元素設定變數（不經 React state），所以圖示欄／AppShell 不會因進度事件重繪。
 */
export function QueueRing(): JSX.Element {
  const store = useQueueStore()
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const apply = (): void => {
      const pct = Math.round(Math.min(1, Math.max(0, store.getSummary().progress)) * 100)
      ref.current?.style.setProperty('--p', String(pct))
    }
    apply()
    return store.subscribe(apply)
  }, [store])

  return <span ref={ref} className="ring" aria-hidden="true" />
}
