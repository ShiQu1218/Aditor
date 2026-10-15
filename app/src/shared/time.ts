import { VideoInfo } from './types'

/**
 * Chromium HTML5 <video> 對 MP4/WebM 檔案的 currentTime 一律從檔案開頭的 0.0 起算，
 * 與引擎解碼輸出 t = k * 0.25（從影片開頭起算）一致。
 * 因此 startOffset 為 0.0。
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
