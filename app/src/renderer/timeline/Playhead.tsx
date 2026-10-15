import React, { useEffect, useRef } from 'react'
import { View, timeToX } from './model'

export function playheadX(t: number, view: View): { x: number; visible: boolean } {
  const x = timeToX(t, view)
  return { x, visible: x >= 0 && x <= view.width }
}

/** 播放中一律讀即時時間（video.currentTime）；props.time 來自 ~4Hz 的 timeupdate，會落後而造成倒退 */
export function playheadTarget(a: { playing?: boolean; time: number; getTime?: () => number }): number {
  if (a.playing && a.getTime) {
    const t = a.getTime()
    if (typeof t === 'number' && Number.isFinite(t)) return t
  }
  return a.time
}

interface PlayheadProps {
  time: number
  view: View
  /** 播放中以 rAF 讀取目前時間（例如 video.currentTime），不經 React 重繪 */
  getTime?: () => number
  playing?: boolean
}

/**
 * 播放頭：DOM 元素，以 style.transform 移動；不觸發 canvas 重繪。
 * 外觀由 CSS（.tl-playhead）以 --tl-playhead 繪製。
 */
export function Playhead({ time, view, getTime, playing }: PlayheadProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const viewRef = useRef(view)
  viewRef.current = view

  const place = (t: number): void => {
    const el = ref.current
    if (!el) return
    const { x, visible } = playheadX(t, viewRef.current)
    el.style.transform = `translateX(${x}px)`
    el.style.opacity = visible ? '1' : '0'
  }

  const getTimeRef = useRef(getTime)
  getTimeRef.current = getTime
  const hasGetTime = !!getTime

  // time／view 改變時定位；播放中改讀即時時間，不使用落後的 time
  useEffect(() => {
    place(playheadTarget({ playing, time, getTime: getTimeRef.current }))
  }, [time, view.start, view.span, view.width, playing])

  // 播放中的 rAF 迴圈只依 playing 啟停（getTime 以 ref 讀取，父層 inline 函式不會使其重啟）
  useEffect(() => {
    if (!playing || !hasGetTime) return
    let id = 0
    const tick = (): void => {
      place(getTimeRef.current!())
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing, hasGetTime])

  return <div ref={ref} className="tl-playhead" aria-hidden="true" />
}
