import { useEffect, useRef, useState } from 'react'
import type { LiveEvent, LiveState, LiveUpdate } from '../../shared/recording'
import { applyLiveUpdate, newCountedEvents } from './liveModel'

export type LiveLoad = 'loading' | 'none' | 'ready'

export interface LiveStateHook {
  load: LiveLoad
  state: LiveState | null
  /** Output file after recording finishes (available only after the `finalized` update). */
  finalized: string[] | null
  /** Most recent newly counted event (for aria-live announcement). */
  latestKill: LiveEvent | null
  /** New segment for the player to append. */
  onSegment: React.MutableRefObject<((segment: LiveState['segments'][number]) => void) | null>
}

/** Subscribe to `recording:live` before reading the snapshot, then apply updates received before the snapshot. If init.mp4 is not written yet (mime=null), reread when a new segment arrives. */
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
