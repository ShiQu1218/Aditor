import { useEffect, useRef, type RefObject } from 'react'
import { settle, stepSync } from './avSync'

interface FrameMetadata { mediaTime: number }
type Rvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMetadata) => void) => number
  cancelVideoFrameCallback?: (id: number) => void
}

/** Reports once per source when preview frames lag the audio clock for seconds (seen with NVIDIA GPUs on Electron 45). */
export function usePreviewSyncMonitor(videoRef: RefObject<HTMLVideoElement>, playing: boolean, src: string): void {
  const reportedSrc = useRef<string | null>(null)
  useEffect(() => {
    const el = videoRef.current as Rvfc | null
    if (!el || !playing || typeof el.requestVideoFrameCallback !== 'function') return
    let state = settle(performance.now())
    const reset = (): void => { state = settle(performance.now()) }
    const events = ['seeking', 'waiting', 'ratechange'] as const
    for (const name of events) el.addEventListener(name, reset)
    let id = 0
    let stopped = false
    const loop = (now: number, meta: FrameMetadata): void => {
      if (stopped) return
      // A muted element has no audio clock to drift against.
      if (reportedSrc.current !== src && !el.seeking && !el.muted) {
        const step = stepSync(state, now, el.currentTime - meta.mediaTime)
        state = step.state
        if (step.desync) {
          reportedSrc.current = src
          const quality = el.getVideoPlaybackQuality?.()
          void window.api?.telemetry?.reportPlaybackDesync?.({
            driftMs: Math.round(step.state.worstDriftS * 1000),
            droppedFrames: quality?.droppedVideoFrames ?? 0,
            totalFrames: quality?.totalVideoFrames ?? 0
          })
        }
      }
      id = el.requestVideoFrameCallback!(loop)
    }
    id = el.requestVideoFrameCallback(loop)
    return () => {
      stopped = true
      el.cancelVideoFrameCallback?.(id)
      for (const name of events) el.removeEventListener(name, reset)
    }
  }, [videoRef, playing, src])
}
