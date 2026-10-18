import { useEffect, useRef, useState } from 'react'
import type { LiveEvent, LiveState, LiveUpdate } from '../../shared/recording'
import { applyLiveUpdate, newCountedEvents } from './liveModel'

export type LiveLoad = 'loading' | 'none' | 'ready'

export interface LiveStateHook {
  load: LiveLoad
  state: LiveState | null
  /** 錄影收尾後的輸出檔（收到 `finalized` 推播才有值） */
  finalized: string[] | null
  /** 最新一筆新計入事件（aria-live 宣告用） */
  latestKill: LiveEvent | null
  /** 新段落（播放器依此 append） */
  onSegment: React.MutableRefObject<((segment: LiveState['segments'][number]) => void) | null>
}

/** 先訂閱 `recording:live` 再讀快照，快照之前到的推播在讀到後補套用。init.mp4 尚未寫出（mime＝null）時，新段落到達會再讀一次。 */
export function useLiveState(): LiveStateHook {
  const [load, setLoad] = useState<LiveLoad>('loading')
  const [state, setState] = useState<LiveState | null>(null)
  const [finalized, setFinalized] = useState<string[] | null>(null)
  const [latestKill, setLatestKill] = useState<LiveEvent | null>(null)
  const onSegment = useRef<((segment: LiveState['segments'][number]) => void) | null>(null)

  useEffect(() => {
    const api = window.api?.recording
    if (!api?.getLive) {
      setLoad('none')
      return
    }
    let alive = true
    let current: LiveState | null = null
    let pending: LiveUpdate[] = []
    let refreshing = false
    const commit = (next: LiveState): void => {
      current = next
      setState(next)
    }
    const refreshMime = (): void => {
      if (refreshing || !current || current.mime) return
      refreshing = true
      void api.getLive!().then((fresh) => {
        refreshing = false
        if (alive && fresh && current && fresh.sessionId === current.sessionId && fresh.mime) commit({ ...current, mime: fresh.mime })
      }, () => { refreshing = false })
    }
    const apply = (update: LiveUpdate): void => {
      if (update.finalized && (!current || update.sessionId === current.sessionId)) setFinalized(update.finalized)
      if (!current) {
        pending = [...pending, update]
        return
      }
      if (update.sessionId !== current.sessionId) return
      if (update.events) {
        const fresh = newCountedEvents(current.events, update.events)
        if (fresh.length) setLatestKill(fresh[fresh.length - 1])
      }
      commit(applyLiveUpdate(current, update))
      if (update.segment) {
        onSegment.current?.(update.segment)
        refreshMime()
      }
    }
    const off = api.onLive?.(apply)
    api.getLive().then((snapshot) => {
      if (!alive) return
      if (!snapshot) {
        setLoad('none')
        return
      }
      commit(pending.reduce(applyLiveUpdate, snapshot))
      pending = []
      setLoad('ready')
    }, () => { if (alive) setLoad('none') })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  return { load, state, finalized, latestKill, onSegment }
}
