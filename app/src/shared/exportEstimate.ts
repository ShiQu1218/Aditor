/** Rough export-size estimate (pure function shared by the export drawer and main disk-space check). */
export type ExportQuality = 'copy' | 'precise'

export interface EstimateItem {
  start: number
  end: number
}

/** Assumed bitrates: copy preserves original quality (about 30 Mbps); precise transcoding uses about 12 Mbps. */
export const COPY_BYTES_PER_SECOND = (30 * 1024 * 1024) / 8
export const PRECISE_BYTES_PER_SECOND = (12 * 1024 * 1024) / 8

export function estimateOutputBytes(project: { items: EstimateItem[] }, quality: ExportQuality): number {
  let totalDur = 0
  for (const item of project.items) {
    const d = item.end - item.start
    if (Number.isFinite(d) && d > 0) totalDur += d
  }
  const bps = quality === 'copy' ? COPY_BYTES_PER_SECOND : PRECISE_BYTES_PER_SECOND
  return Math.ceil(totalDur * bps)
}
