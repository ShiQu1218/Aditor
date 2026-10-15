export function toCurrentTime(t: number, startOffset: number): number {
  return t + startOffset
}

export function fromCurrentTime(ct: number, startOffset: number): number {
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
