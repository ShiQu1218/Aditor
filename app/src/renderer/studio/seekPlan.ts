/** Video src and seek plan (pure function): apply the target time only after switching sources, never to the <video> being replaced. */

export function fileUrl(path: string): string {
  return `file://${encodeURI(path.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

/** Apply the seek immediately if its file is loaded; otherwise defer until loadedmetadata. */
export function planSeek(i: { loadedSrc: string | null; wantedSrc: string }): 'now' | 'defer' {
  return i.loadedSrc !== null && i.loadedSrc === i.wantedSrc ? 'now' : 'defer'
}

/**
 * Route timeupdate events:
 * - Project preview: preview file is loaded and no seek is pending → 'preview' (sync source and project playheads).
 * - Source mode: source file is loaded and no seek is pending → 'source'.
 * - Otherwise (stale events from the old video or source-switch transition) → 'ignore'.
 */
export function routeTimeUpdate(i: {
  previewSrc: string | null
  sourceSrc: string
  loadedSrc: string | null
  pending: boolean
}): 'source' | 'preview' | 'ignore' {
  if (i.pending) return 'ignore'
  if (i.previewSrc !== null) return i.loadedSrc === i.previewSrc ? 'preview' : 'ignore'
  return i.loadedSrc === i.sourceSrc ? 'source' : 'ignore'
}

/**
 * On <video> load failure, discard any pending seek (otherwise it could apply to the next file that loads successfully),
 * clear the loaded marker, and set playing to false.
 */
export function onVideoError(_i: { loadedSrc: string | null; pending: { t: number; play: boolean } | null }): {
  loadedSrc: null
  pending: null
  playing: false
} {
  return { loadedSrc: null, pending: null, playing: false }
}
