import { useCallback, useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { EngineEvent, EventType } from '../../shared/types'
import { formatTime, toCurrentTime } from '../../shared/time'
import type { Project, ProjectItem } from '../editor/project'
import { nextEvent } from '../timeline/model'
import { i18n } from '../i18n'
import { leadInSeek } from './studioSettings'
import { reconcileMode, type ModeAction, type ModeState } from './mode'
import { createAnnouncer } from './liveAnnouncer'
import { eventAriaLabel } from './reasons'
import { navReference, type NavAnchor } from './eventNav'
import { fileUrl, planSeek } from './seekPlan'

interface SourcePlaybackOptions {
  videoRef: RefObject<HTMLVideoElement>
  videoPath: string
  proxyPath: string | null
  mode: ModeState
  dispatchMode: Dispatch<ModeAction>
  speed: number
  setSpeed: Dispatch<SetStateAction<number>>
  isPlaying: boolean
  setCurrentTime: (t: number) => void
  setLive: (msg: string) => void
  duration: number
  events: EngineEvent[]
  filter: Set<EventType>
  before: number
  project: Project
  previewRef: MutableRefObject<{ item: ProjectItem | null }>
  projectRef: MutableRefObject<Project>
}

/** Source-side transport: seek bookkeeping across src switches, scrubbing, hover preview, and event navigation. */
export function useStudioSourcePlayback({
  videoRef,
  videoPath,
  proxyPath,
  mode,
  dispatchMode,
  speed,
  setSpeed,
  isPlaying,
  setCurrentTime,
  setLive,
  duration,
  events,
  filter,
  before,
  project,
  previewRef,
  projectRef
}: SourcePlaybackOptions) {
  const hoverPreviewRef = useRef<{ time: number; playing: boolean } | null>(null)
  const scrubSessionRef = useRef<{ item: ProjectItem | null; time: number; playing: boolean } | null>(null)
  const previewRestoreRef = useRef<{ id: string; time: number; playing: boolean } | null>(null)

  // Latest values for event handlers (avoid stale closures and rebuilding callbacks every frame).
  const modeRef = useRef(mode)
  modeRef.current = mode
  const speedRef = useRef(speed)
  speedRef.current = speed

  /** Current source playhead value. */
  const currentTimeRef = useRef(0)
  /** src for the currently loaded <video> (set after loadedmetadata and cleared when switching files). */
  const loadedSrcRef = useRef<string | null>(null)
  /** Seek to apply after the new src loads (never set currentTime on a <video> that is about to be replaced). */
  const pendingSeekRef = useRef<{ t: number; play: boolean } | null>(null)

  const sourceSrc = useMemo(() => fileUrl(proxyPath ?? videoPath), [proxyPath, videoPath])
  const videoSrc = sourceSrc
  const sourceSrcRef = useRef(sourceSrc)
  sourceSrcRef.current = sourceSrc
  const videoSrcRef = useRef(videoSrc)
  videoSrcRef.current = videoSrc

  /** Seek the <video> to t: apply immediately if the target file is loaded, or wait for loadedmetadata. */
  const requestSeek = useCallback((t: number, wantedSrc: string, play: boolean): void => {
    const el = videoRef.current
    if (el && planSeek({ loadedSrc: loadedSrcRef.current, wantedSrc }) === 'now') {
      pendingSeekRef.current = null
      el.currentTime = toCurrentTime(t, 0)
      if (play) void el.play().catch(() => {})
      return
    }
    pendingSeekRef.current = { t, play }
  }, [])

  const handleLoadedMetadata = useCallback((): void => {
    const el = videoRef.current
    if (!el) return
    loadedSrcRef.current = videoSrcRef.current
    el.playbackRate = speedRef.current // Reapply playback speed after each file switch.
    const p = pendingSeekRef.current
    if (p) {
      pendingSeekRef.current = null
      el.currentTime = toCurrentTime(p.t, 0)
      if (p.play) void el.play().catch(() => {})
    }
  }, [])

  // On file switch, invalidate the old loaded marker; when the proxy is ready, preserve source/project-preview position and playback state.
  const prevSrcRef = useRef(videoSrc)
  useEffect(() => {
    if (prevSrcRef.current === videoSrc) return
    prevSrcRef.current = videoSrc
    loadedSrcRef.current = null
    if (!pendingSeekRef.current) {
      pendingSeekRef.current = { t: currentTimeRef.current, play: isPlaying }
    }
  }, [videoSrc])

  /** Current source playhead time (use the saved time while switching files). */
  const sourcePlayTime = useCallback((): number => {
    const el = videoRef.current
    if (hoverPreviewRef.current) return hoverPreviewRef.current.time
    if (
      !el ||
      pendingSeekRef.current ||
      loadedSrcRef.current !== sourceSrcRef.current
    ) {
      return currentTimeRef.current
    }
    return el.currentTime
  }, [])

  // Throttle keyboard-driven playhead/zoom changes and announce them through polite aria-live.
  const announcerRef = useRef<ReturnType<typeof createAnnouncer> | null>(null)
  useEffect(() => {
    const a = createAnnouncer(setLive)
    announcerRef.current = a
    return () => a.dispose()
  }, [])
  const announce = useCallback((msg: string): void => announcerRef.current?.announce(msg), [])

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }, [])

  const cycleSpeed = useCallback(() => {
    const speeds = [1.0, 0.5, 0.25, 2.0]
    setSpeed((prev) => {
      const next = speeds[(speeds.indexOf(prev) + 1) % speeds.length]
      if (videoRef.current) videoRef.current.playbackRate = next
      return next
    })
  }, [])

  /** For any source seek (timeline, event, highlight preview, or arrow keys), return to source mode first and apply the time after switching files. */
  const seekTo = useCallback(
    (t: number) => {
      const clamped = Math.max(0, t)
      if (modeRef.current.mode === 'project') dispatchMode({ type: 'seekSource' })
      requestSeek(clamped, sourceSrcRef.current, false)
      currentTimeRef.current = clamped
      setCurrentTime(clamped)
    },
    [requestSeek]
  )

  /** Pause before dragging; resume the original playback state on release, or restore the original project preview on cancel. */
  const startScrub = useCallback((): void => {
    const el = videoRef.current
    scrubSessionRef.current = { item: previewRef.current.item, time: el?.currentTime ?? 0, playing: !!el && !el.paused }
    el?.pause()
  }, [])
  const endScrub = useCallback((cancelled: boolean): void => {
    const session = scrubSessionRef.current
    scrubSessionRef.current = null
    if (!session) return
    if (cancelled && session.item && projectRef.current.items.some((item) => item.id === session.item!.id)) {
      if (modeRef.current.mode === 'project') {
        dispatchMode({ type: 'playItem', item: session.item })
        requestSeek(session.time, videoSrcRef.current, session.playing)
        return
      }
      previewRestoreRef.current = { id: session.item.id, time: session.time, playing: session.playing }
      dispatchMode({ type: 'playItem', item: session.item })
    } else requestSeek(currentTimeRef.current, sourceSrcRef.current, session.playing)
  }, [requestSeek])

  /** Blade hover changes only the preview frame; the source playhead and saved time stay in place. */
  const hoverSeek = useCallback((t: number | null): void => {
    const el = videoRef.current
    if (t === null) {
      const session = hoverPreviewRef.current
      hoverPreviewRef.current = null
      if (session) requestSeek(session.time, sourceSrcRef.current, session.playing)
      return
    }
    if (modeRef.current.mode !== 'source') return
    if (!hoverPreviewRef.current) {
      const time = sourcePlayTime()
      hoverPreviewRef.current = { time, playing: !!el && !el.paused }
      currentTimeRef.current = time
      setCurrentTime(time)
      el?.pause()
    }
    requestSeek(t, sourceSrcRef.current, false)
  }, [requestSeek, sourcePlayTime])

  /** Return to source (Esc or banner button) at the current clip's source time so editing can continue there. */
  const backToSource = useCallback(() => {
    if (modeRef.current.mode !== 'project') return
    dispatchMode({ type: 'backToSource' })
    videoRef.current?.pause()
    requestSeek(currentTimeRef.current, sourceSrcRef.current, false)
  }, [requestSeek])

  // If the previewed clip no longer exists (for example, Undo removed it), return to source mode.
  useEffect(() => {
    if (reconcileMode(mode, project) !== mode) backToSource()
  }, [mode, project, backToSource])

  const seekBy = useCallback(
    (delta: number) => {
      const target = Math.max(0, Math.min(duration, sourcePlayTime() + delta))
      seekTo(target)
      announce(i18n.studio.live.playhead.replace('{time}', formatTime(target)))
    },
    [duration, sourcePlayTime, seekTo, announce]
  )

  /** Event just reached with Ctrl+←/→ (when the playhead is at its lead-in, use the event time as the next navigation reference; see eventNav). */
  const navAnchorRef = useRef<NavAnchor | null>(null)
  const seekEvent = useCallback(
    (dir: 1 | -1) => {
      const ev = nextEvent(events, navReference(currentTimeRef.current, navAnchorRef.current), dir, filter)
      if (!ev) return
      const target = leadInSeek(ev.t, before)
      seekTo(target)
      navAnchorRef.current = { eventT: ev.t, seekT: target }
      // Announce the event itself—type, time, and whether it counts (including the reason when it does not)—rather than only the playhead time.
      announce(eventAriaLabel(ev))
    },
    [events, filter, seekTo, announce, before]
  )

  const handleSelectEvent = useCallback(
    (ev: { t: number }) => {
      seekTo(leadInSeek(ev.t, before))
    },
    [seekTo, before]
  )

  return {
    hoverPreviewRef,
    previewRestoreRef,
    modeRef,
    speedRef,
    currentTimeRef,
    loadedSrcRef,
    pendingSeekRef,
    sourceSrcRef,
    videoSrc,
    videoSrcRef,
    requestSeek,
    handleLoadedMetadata,
    sourcePlayTime,
    announce,
    togglePlay,
    cycleSpeed,
    seekTo,
    startScrub,
    endScrub,
    hoverSeek,
    backToSource,
    seekBy,
    seekEvent,
    handleSelectEvent
  }
}

export type StudioSourcePlayback = ReturnType<typeof useStudioSourcePlayback>
