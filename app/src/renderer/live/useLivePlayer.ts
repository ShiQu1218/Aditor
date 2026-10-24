import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveSegment } from '../../shared/recording'
import { covers, LIVE_EDGE_OFFSET, LiveBuffer, type SourceBufferLike } from './liveBuffer'

export type PlayerError = { kind: 'unsupported'; mime: string } | { kind: 'load'; message: string } | null

export interface LivePlayer {
  videoRef: React.RefObject<HTMLVideoElement>
  current: number
  playing: boolean
  error: PlayerError
  seek: (t: number) => void
  togglePlay: () => void
  jumpLive: () => void
  addSegment: (segment: LiveSegment) => void
}

interface PlayerInput {
  sessionId: string | null
  mime: string | null
  segments: LiveSegment[]
  /** Playable range (the start of the retained range through the end of the recording). */
  bounds: () => { start: number; end: number }
}

/**
 * MediaSource playback: create SourceBuffer and LiveBuffer on sourceopen; on open, seek near the live edge and autoplay.
 * Time updates drive segment fetches; recheck the buffer when seeking or paused.
 */
export function useLivePlayer({ sessionId, mime, segments, bounds }: PlayerInput): LivePlayer {
  const videoRef = useRef<HTMLVideoElement>(null)
  const bufferRef = useRef<LiveBuffer | null>(null)
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  /** Keep the requested time while its segments load, independent of the old playhead. */
  const startRef = useRef<number | null>(null)
  const applySeekRef = useRef<(() => void) | null>(null)
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<PlayerError>(null)

  useEffect(() => {
    const video = videoRef.current
    const api = window.api?.recording
    if (!video || !sessionId || !mime || !api?.readInit || !api.readSegment) return
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
      setError({ kind: 'unsupported', mime })
      return
    }
    const readInit = api.readInit
    const readSegment = api.readSegment
    setError(null)
    startRef.current = Math.max(0, boundsRef.current().end - LIVE_EDGE_OFFSET)
    const ms = new MediaSource()
    const url = URL.createObjectURL(ms)
    let buffer: LiveBuffer | null = null
    let sb: SourceBuffer | null = null
    let autoplay = true
    const applySeek = (): void => {
      const target = startRef.current
      if (target === null || video.readyState === 0 || !sb || !covers(sb.buffered, target)) return
      startRef.current = null
      video.currentTime = target
      setCurrent(target)
      if (autoplay) {
        autoplay = false
        void video.play().catch(() => undefined)
      }
    }
    applySeekRef.current = applySeek
    const onOpen = (): void => {
      URL.revokeObjectURL(url)
      try { sb = ms.addSourceBuffer(mime) }
      catch {
        setError({ kind: 'unsupported', mime })
        return
      }
      buffer = new LiveBuffer({
        sourceBuffer: sb as unknown as SourceBufferLike,
        fetchInit: () => readInit(sessionId),
        fetchSegment: (seq) => readSegment(sessionId, seq),
        currentTime: () => startRef.current ?? video.currentTime,
        setDuration: (seconds) => {
          if (ms.readyState !== 'open' || !sb || sb.updating || !(seconds > 0)) return
          if (Number.isNaN(ms.duration) || ms.duration < seconds) {
            try { ms.duration = seconds } catch { /* Another operation is in progress; retry next time. */ }
          }
        },
        onError: (err) => setError({ kind: 'load', message: err instanceof Error ? err.message : String(err) }),
        onBuffered: applySeek
      })
      bufferRef.current = buffer
      buffer.setSegments(segmentsRef.current)
    }
    const onMeta = (): void => {
      applySeek()
    }
    const onTime = (): void => {
      setCurrent(startRef.current ?? video.currentTime)
      bufferRef.current?.pump()
    }
    const onSeek = (): void => {
      setCurrent(startRef.current ?? video.currentTime)
      bufferRef.current?.revalidate()
    }
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    ms.addEventListener('sourceopen', onOpen, { once: true })
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('seeking', onSeek)
    video.addEventListener('waiting', onSeek)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.src = url
    return () => {
      ms.removeEventListener('sourceopen', onOpen)
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('seeking', onSeek)
      video.removeEventListener('waiting', onSeek)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      buffer?.dispose()
      bufferRef.current = null
      applySeekRef.current = null
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
    }
  }, [sessionId, mime])

  const seek = useCallback((t: number): void => {
    const { start, end } = boundsRef.current()
    const target = Math.min(Math.max(t, start), Math.max(start, end - 0.1))
    const video = videoRef.current
    setCurrent(target)
    if (!video) return
    startRef.current = target
    applySeekRef.current?.()
    bufferRef.current?.revalidate()
  }, [])

  const togglePlay = useCallback((): void => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }, [])

  const jumpLive = useCallback((): void => {
    seek(boundsRef.current().end - LIVE_EDGE_OFFSET)
    const video = videoRef.current
    if (video?.paused) void video.play().catch(() => undefined)
  }, [seek])

  const previousSegments = useRef(segments)
  useEffect(() => {
    const available = new Set(segments.map(s => s.seq))
    if (previousSegments.current.some(s => !available.has(s.seq))) {
      setError(error => error?.kind === 'load' ? null : error)
    }
    previousSegments.current = segments
    bufferRef.current?.setSegments(segments)
  }, [segments])

  const addSegment = useCallback((segment: LiveSegment): void => { bufferRef.current?.addSegment(segment) }, [])

  return { videoRef, current, playing, error, seek, togglePlay, jumpLive, addSegment }
}
