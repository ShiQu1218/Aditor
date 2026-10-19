import { VideoInfo } from './types'

/**
 * Chromium HTML5 <video> measures currentTime for MP4/WebM files from 0.0 at the start of the file,
 * matching the engine's decoded output t = k * 0.25 (also measured from the start of the video).
 * Therefore, startOffset is 0.0.
 */
export function getStartOffset(_info?: VideoInfo): number {
  return 0.0
}

export function toCurrentTime(t: number, startOffset: number = 0.0): number {
  return t + startOffset
}

export function fromCurrentTime(ct: number, startOffset: number = 0.0): number {
  return Math.max(0, ct - startOffset)
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const remS = s % 60
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${remS.toString().padStart(2, '0')}`
  }
  return `${m}:${remS.toString().padStart(2, '0')}`
}
