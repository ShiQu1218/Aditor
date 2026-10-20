import React from 'react'
import { i18n } from '../i18n'
import { ModePill } from './ModePill'

interface PlayerStageProps {
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

  /** Player stage: mode pill (top-left), last-90-second count (top-right), and video. */
export function PlayerStage({
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
  React.useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume / 100
  }, [videoRef, volume, src])

  return (
    <div className="stage">
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
    </div>
  )
}
