import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { CacheDoc } from '../../shared/types'
import type { PlayabilityResult } from '../media/playability'
import { i18n } from '../i18n'
import type { useToast } from '../shell/ToastHost'
import { NoticeAction, proxyBusyNotice, studioNotice, StudioNotice } from './notices'
import { normPath } from './studioScreenModel'

type ProxyState = 'none' | 'available' | 'generating'

interface StudioNoticesOptions {
  videoPath: string
  reloadKey: number
  duration: number
  docAnalysis: CacheDoc['analysis']
  videoMissing: boolean
  setVideoMissing: (missing: boolean) => void
  playability: PlayabilityResult
  proxyState: ProxyState
  setProxyState: (state: ProxyState) => void
  setProxyPath: (path: string | null) => void
  proxySuggest: boolean
  loadError: { code?: string | number; message: string } | null
  setLoadError: (error: null) => void
  setReloadKey: Dispatch<SetStateAction<number>>
  removalPending: MutableRefObject<boolean>
  canLeaveStudio: () => boolean
  onBack: () => void
  toast: ReturnType<typeof useToast>
}

/** Status bar (engine errors and proxies), proxy generation, and the notice/back actions. */
export function useStudioNotices({
  videoPath,
  reloadKey,
  duration,
  docAnalysis,
  videoMissing,
  setVideoMissing,
  playability,
  proxyState,
  setProxyState,
  setProxyPath,
  proxySuggest,
  loadError,
  setLoadError,
  setReloadKey,
  removalPending,
  canLeaveStudio,
  onBack,
  toast
}: StudioNoticesOptions): {
  shownNotice: StudioNotice | null
  requestBack: () => void
  handleNoticeAction: (a: NoticeAction) => void
} {
  const [proxyPct, setProxyPct] = useState<number | null>(null)
  const [proxyDismissed, setProxyDismissed] = useState(false)

  useEffect(() => setVideoMissing(false), [videoPath, reloadKey])
  // docAnalysis is kept as a recompute trigger even though the notice no longer reads it.
  const notice: StudioNotice | null = useMemo(() => {
    const base = studioNotice({
      analysis: 'done',
      videoMissing,
      playability,
      proxyState,
      proxySuggest
    })
    if (proxyDismissed && base?.id === 'proxy-suggest') return null
    return base
  }, [playability, proxyState, proxyDismissed, proxySuggest, docAnalysis, videoMissing])

  const busyNotice: StudioNotice | null = useMemo(
    () => (proxyState === 'generating' ? proxyBusyNotice(proxyPct) : null),
    [proxyState, proxyPct]
  )
  const shownNotice = notice ?? busyNotice

  // Proxy generation progress pushed by main after parsing ffmpeg output.
  useEffect(() => {
    const off = window.api?.proxy?.onProgress?.((d: { videoPath: string; ratio: number }) => {
      if (normPath(d.videoPath) === normPath(videoPath)) setProxyPct(d.ratio)
    })
    return () => off?.()
  }, [videoPath])

  const handleGenerateProxy = useCallback(async (): Promise<void> => {
    setProxyState('generating')
    setProxyPct(null)
    try {
      const p: string | null = await window.api?.proxy?.generate?.(videoPath, duration)
      if (p) {
        setProxyPath(p)
        setProxyState('available')
      } else {
        setProxyState('none')
      }
    } catch (err) {
      console.error('Failed to generate proxy:', err)
      setProxyState('none')
    }
  }, [videoPath, duration])

  /** Return to the library; while export is running, stay in the studio and show a Toast instead. */
  const requestBack = useCallback((): void => {
    if (removalPending.current || !canLeaveStudio()) return
    onBack()
  }, [canLeaveStudio, onBack])

  const handleNoticeAction = useCallback(
    (a: NoticeAction): void => {
      if (a === 'resume') {
        setLoadError(null)
        setReloadKey((k) => k + 1)
      } else if (a === 'copyError') {
        void navigator.clipboard?.writeText(loadError?.message ?? '').catch(() => {})
        toast({ message: i18n.studio.toast.copied })
      } else if (a === 'generateProxy') {
        void handleGenerateProxy()
      } else if (a === 'later') {
        setProxyDismissed(true)
      } else if (a === 'back') {
        requestBack()
      } else if (a === 'relink') {
        // Relink returns to the library, where the user can remove the invalid entry and import the file again.
        toast({ message: i18n.studio.toast.relinkHint })
        requestBack()
      }
    },
    [loadError, handleGenerateProxy, toast, requestBack]
  )

  return { shownNotice, requestBack, handleNoticeAction }
}
