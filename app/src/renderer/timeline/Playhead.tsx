import React, { useEffect, useRef } from 'react'
import { View, timeToX } from './model'

export function playheadX(t: number, view: View): { x: number; visible: boolean } {
  const x = timeToX(t, view)
  return { x, visible: x >= 0 && x <= view.width }
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

  // 非播放：time／view 改變時直接定位
  useEffect(() => {
    place(time)
  }, [time, view.start, view.span, view.width])

  useEffect(() => {
    if (!playing || !getTime) return
    let id = 0
    const tick = (): void => {
      place(getTime())
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing, getTime])

  return <div ref={ref} className="tl-playhead" aria-hidden="true" />
}
