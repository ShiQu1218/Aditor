import React from 'react'
import { i18n } from '../i18n/zh-TW'
import { ModePill } from './ModePill'

interface PlayerStageProps {
  videoRef: React.RefObject<HTMLVideoElement>
  src: string
  mode: 'source' | 'project'
  modeLabel: string
  spectating: boolean
  /** 近 90 秒計入事件數（0 時不顯示，資訊用） */
  recentCounted: number
  onTogglePlay: () => void
  onTimeUpdate: (t: number) => void
  onPlayingChange: (playing: boolean) => void
}

/** 播放器舞台：模式膠囊（左上）、近 90 秒計數（右上）、影片本體。 */
export function PlayerStage({
  videoRef,
  src,
  mode,
  modeLabel,
  spectating,
  recentCounted,
  onTogglePlay,
  onTimeUpdate,
  onPlayingChange
}: PlayerStageProps): JSX.Element {
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
        onClick={onTogglePlay}
        onTimeUpdate={(e) => onTimeUpdate((e.target as HTMLVideoElement).currentTime)}
        onPlay={() => onPlayingChange(true)}
        onPause={() => onPlayingChange(false)}
      />
    </div>
  )
}
