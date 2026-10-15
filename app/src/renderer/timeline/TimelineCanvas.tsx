import React, { useRef, useEffect, useState, useCallback } from 'react'
import { View, timeToX, xToTime, zoom, pan, heatmap, hitTestEvent } from './model'
import { Clip, EngineEvent, EventType, SpecInterval, isCounted } from '../../shared/types'
import { resizeClip } from './clips'

interface TimelineCanvasProps {
  duration: number
  currentTime: number
  events: EngineEvent[]
  spectating: SpecInterval[]
  clips: Clip[]
  filter: Set<EventType>
  onSeek: (t: number) => void
  onSelectEvent?: (e: EngineEvent) => void
  onUpdateClip?: (clip: Clip) => void
}

const EVENT_COLORS: Record<string, string> = {
  knock: '#e13b30',
  assist_knock: '#38bdf8',
  assist_elim: '#60a5fa',
  elim: '#f97316',
  squad_wipe: '#a855f7'
}

export function TimelineCanvas({
  duration,
  currentTime,
  events,
  spectating,
  clips,
  filter,
  onSeek,
  onSelectEvent,
  onUpdateClip
}: TimelineCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [view, setView] = useState<View>({
    duration: Math.max(1, duration),
    start: 0,
    span: Math.max(1, duration),
    width: 800
  })

  const [dragHandle, setDragHandle] = useState<{
    clipId: string
    edge: 'start' | 'end'
  } | null>(null)

  // Update view width on resize
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth
        setView((v) => ({ ...v, width: w, duration: Math.max(1, duration) }))
      }
    }
    updateWidth()
    window.addEventListener('resize', updateWidth)
    return () => window.removeEventListener('resize', updateWidth)
  }, [duration])

  // Reset span when duration changes if span was full
  useEffect(() => {
    setView((v) => ({
      ...v,
      duration: Math.max(1, duration),
      span: Math.min(Math.max(1, duration), v.span)
    }))
  }, [duration])

  // Draw canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width } = view
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)

    // Background
    ctx.fillStyle = '#1e2029'
    ctx.fillRect(0, 0, width, height)

    // Heatmap (bottom 16px)
    const bins = Math.min(200, Math.floor(width / 4))
    const heat = heatmap(events, duration, bins)
    const heatH = 14
    const heatY = height - heatH
    for (let i = 0; i < bins; i++) {
      const val = heat[i]
      if (val > 0) {
        const binT0 = (i / bins) * duration
        const binT1 = ((i + 1) / bins) * duration
        const x0 = timeToX(binT0, view)
        const x1 = timeToX(binT1, view)
        ctx.fillStyle = `rgba(225, 59, 48, ${0.15 + val * 0.6})`
        ctx.fillRect(x0, heatY, Math.max(1, x1 - x0), heatH)
      }
    }

    // Spectating intervals (shaded gray)
    for (const spec of spectating) {
      const sx = timeToX(spec.start, view)
      const ex = timeToX(spec.end, view)
      ctx.fillStyle = 'rgba(100, 116, 139, 0.25)'
      ctx.fillRect(sx, 0, Math.max(1, ex - sx), height)
    }

    // Clips
    for (const c of clips) {
      const cx0 = timeToX(c.start, view)
      const cx1 = timeToX(c.end, view)
      const cWidth = Math.max(4, cx1 - cx0)
      const isAi = c.origin === 'ai'

      // Clip body
      ctx.fillStyle = isAi ? 'rgba(56, 189, 248, 0.25)' : 'rgba(34, 197, 94, 0.25)'
      ctx.fillRect(cx0, 10, cWidth, height - 30)

      // Clip border
      ctx.strokeStyle = isAi ? '#38bdf8' : '#22c55e'
      ctx.lineWidth = 1.5
      ctx.strokeRect(cx0, 10, cWidth, height - 30)

      // Left & right handle indicators
      ctx.fillStyle = isAi ? '#38bdf8' : '#22c55e'
      ctx.fillRect(cx0 - 2, 10, 4, height - 30)
      ctx.fillRect(cx1 - 2, 10, 4, height - 30)
    }

    // Events markers
    for (const ev of events) {
      if (!filter.has(ev.type as EventType)) {
        continue
      }
      const ex = timeToX(ev.t, view)
      if (ex < -10 || ex > width + 10) continue

      const counted = isCounted(ev)
      const color = EVENT_COLORS[ev.type] || '#fff'

      ctx.fillStyle = counted ? color : 'rgba(148, 163, 184, 0.4)'
      ctx.beginPath()
      ctx.arc(ex, 18, 5, 0, Math.PI * 2)
      ctx.fill()

      // Marker line
      ctx.strokeStyle = counted ? color : 'rgba(148, 163, 184, 0.3)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(ex, 23)
      ctx.lineTo(ex, height - heatH - 2)
      ctx.stroke()
    }

    // Playhead line
    const px = timeToX(currentTime, view)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, height)
    ctx.stroke()

    // Playhead handle
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.moveTo(px - 5, 0)
    ctx.lineTo(px + 5, 0)
    ctx.lineTo(px, 7)
    ctx.closePath()
    ctx.fill()
  }, [view, currentTime, events, spectating, clips, filter, duration])

  useEffect(() => {
    draw()
  }, [draw])

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const t = xToTime(x, view)

    // Check if clicking near a clip edge (tol = 6px)
    for (const c of clips) {
      const sx = timeToX(c.start, view)
      const ex = timeToX(c.end, view)
      if (Math.abs(x - sx) <= 6) {
        setDragHandle({ clipId: c.id, edge: 'start' })
        return
      }
      if (Math.abs(x - ex) <= 6) {
        setDragHandle({ clipId: c.id, edge: 'end' })
        return
      }
    }

    // Check hit test for events
    const hit = hitTestEvent(events, x, view, 8)
    if (hit && onSelectEvent) {
      onSelectEvent(hit)
    }

    onSeek(Math.max(0, Math.min(duration, t)))
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left

    if (dragHandle && onUpdateClip) {
      const t = xToTime(x, view)
      const targetClip = clips.find((c) => c.id === dragHandle.clipId)
      if (targetClip) {
        const updated = resizeClip(targetClip, dragHandle.edge, t, duration)
        onUpdateClip(updated)
      }
    }
  }

  const handleMouseUp = () => {
    setDragHandle(null)
  }

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const anchorT = xToTime(x, view)

    if (e.ctrlKey) {
      const factor = e.deltaY > 0 ? 1.25 : 0.8
      setView((v) => zoom(v, factor, anchorT))
    } else {
      const dt = (e.deltaY / view.width) * view.span * 0.5
      setView((v) => pan(v, dt))
    }
  }

  return (
    <div ref={containerRef} style={{ width: '100%', userSelect: 'none' }}>
      <canvas
        ref={canvasRef}
        width={view.width}
        height={76}
        style={{
          width: '100%',
          height: 76,
          display: 'block',
          cursor: dragHandle ? 'ew-resize' : 'crosshair',
          borderRadius: 6
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      />
    </div>
  )
}
