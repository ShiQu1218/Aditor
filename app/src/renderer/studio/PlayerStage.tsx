import React from 'react'
import { i18n } from '../i18n'
import { ModePill } from './ModePill'
import { Maximize, Minimize } from '../components/icons'

interface PlayerStageProps {
  children?: React.ReactNode
  videoRef: React.RefObject<HTMLVideoElement>
  src: string
  volume: number
  muted: boolean
  mode: 'source' | 'project'
  modeLabel: string
  spectating: boolean
  /** Number of included events in the last 90 seconds (informational; hidden when 0). */
  recentCounted: number
  onTogglePlay: () => void
  onTimeUpdate: (t: number) => void
  onLoadedMetadata: () => void
  onPlayingChange: (playing: boolean) => void
  onEnded: () => void
  onError: () => void
}

/** Preview video, status overlays, and playback controls. */
export function PlayerStage({
  children,
  videoRef,
  src,
  volume,
  muted,
  mode,
  modeLabel,
  spectating,
  recentCounted,
  onTogglePlay,
  onTimeUpdate,
  onLoadedMetadata,
  onPlayingChange,
  onEnded,
  onError
}: PlayerStageProps): JSX.Element {
  const stageRef = React.useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = React.useState(false)
  const [controlsVisible, setControlsVisible] = React.useState(true)
  const hideTimer = React.useRef<ReturnType<typeof setTimeout>>()
  const showControls = (): void => {
    setControlsVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControlsVisible(false), 2500)
  }
  React.useEffect(() => {
    const changed = (): void => setFullscreen(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', changed)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      clearTimeout(hideTimer.current)
    }
  }, [])
  const toggleFullscreen = async (): Promise<void> => {
    try {
      if (document.fullscreenElement === stageRef.current) await document.exitFullscreen()
      else await stageRef.current?.requestFullscreen()
    } catch (error) {
      console.warn('Could not change preview fullscreen:', error)
    }
  }
  React.useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume / 100
  }, [videoRef, volume, src])

  return (
    <div ref={stageRef} className={`stage${controlsVisible ? ' controls-visible' : ''}`}
      onPointerMove={showControls} onPointerLeave={() => setControlsVisible(false)}
      onFocusCapture={showControls}>
      <div className="stage-overlay-top">
        <ModePill mode={mode} label={modeLabel} spectating={spectating} />
        {recentCounted > 0 && (
          <span className="stage-recent mono">{i18n.studio.recentCounted.replace('{n}', String(recentCounted))}</span>
        )}
      </div>
      <video
        ref={videoRef}
        className="stage-video"
        src={src}
        muted={muted}
        onClick={onTogglePlay}
        onTimeUpdate={(e) => onTimeUpdate((e.target as HTMLVideoElement).currentTime)}
        onLoadedMetadata={onLoadedMetadata}
        onEmptied={() => onPlayingChange(false)}
        onPlay={() => onPlayingChange(true)}
        onPause={() => onPlayingChange(false)}
        onEnded={onEnded}
        onError={onError}
      />
      <div className="stage-controls">
        {children}
        <div className="transport-spacer" />
        <button type="button" className="icon-btn" onClick={() => { void toggleFullscreen() }}
          aria-label={fullscreen ? i18n.studio.transport.exitFullscreen : i18n.studio.transport.fullscreen}
          title={fullscreen ? i18n.studio.transport.exitFullscreen : i18n.studio.transport.fullscreen}>
          {fullscreen ? <Minimize className="ic" aria-hidden="true" /> : <Maximize className="ic" aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}
