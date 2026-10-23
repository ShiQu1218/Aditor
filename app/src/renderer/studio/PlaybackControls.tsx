import React from 'react'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n'
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from '../components/icons'

interface PlaybackControlsProps {
  playing: boolean
  currentTime: number
  duration: number
  speed: number
  volume: number
  muted: boolean
  audioDisabled: boolean
  onVolumeChange: (volume: number) => void
  onToggleMute: () => void
  onTogglePlay: () => void
  onCycleSpeed: () => void
  onPrevEvent: () => void
  onNextEvent: () => void
}

export function PlaybackControls({
  playing,
  currentTime,
  duration,
  speed,
  volume,
  muted,
  audioDisabled,
  onVolumeChange,
  onToggleMute,
  onTogglePlay,
  onCycleSpeed,
  onPrevEvent,
  onNextEvent
}: PlaybackControlsProps): JSX.Element {
  const t = i18n.studio.transport
  return (
    <>
      <button type="button" className="play-btn" aria-label={playing ? t.pause : t.play} onClick={onTogglePlay}>
        {playing ? <Pause className="ic" /> : <Play className="ic" />}
      </button>
      <button type="button" className="icon-btn" aria-label={t.prevEvent} onClick={onPrevEvent}>
        <SkipBack className="ic" />
      </button>
      <button type="button" className="icon-btn" aria-label={t.nextEvent} onClick={onNextEvent}>
        <SkipForward className="ic" />
      </button>
      <span className="transport-time mono">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
      <button type="button" className="speed-btn mono" onClick={onCycleSpeed}>
        {speed}x
      </button>
      <div className="preview-volume">
        <button type="button" className="icon-btn" aria-label={muted || volume === 0 ? t.unmute : t.mute}
          aria-pressed={muted || volume === 0} disabled={audioDisabled} onClick={onToggleMute}>
          {muted || volume === 0 ? <VolumeX className="ic" aria-hidden="true" /> : <Volume2 className="ic" aria-hidden="true" />}
        </button>
        <input type="range" min={0} max={100} step={1} value={volume} disabled={audioDisabled}
          aria-label={t.volume} aria-valuetext={`${volume}%`}
          onChange={(e) => onVolumeChange(Number(e.currentTarget.value))} />
        <span className="mono">{volume}%</span>
      </div>
    </>
  )
}
