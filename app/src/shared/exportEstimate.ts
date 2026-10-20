import type { StreamProbe } from './exportCompat'
import { concatRenderSpec, peakBitrateKbps, sourceSpec, type VideoSpec } from './encodeQuality'

/** Rough export-size estimate (pure function shared by the export drawer and main disk-space check). */
export type ExportQuality = 'copy' | 'precise'

export interface EstimateItem {
  source?: string
  start: number
  end: number
}

/** Copy retains its original 30 Mbps assumption; precise keeps the legacy 25 Mbps estimate as a floor. */
export const COPY_BYTES_PER_SECOND = (30 * 1024 * 1024) / 8
export const PRECISE_BYTES_PER_SECOND = (25 * 1024 * 1024) / 8

const preciseBytesPerSecond = (spec: VideoSpec): number =>
  Math.max(PRECISE_BYTES_PER_SECOND, ((peakBitrateKbps(spec) + 192) * 1000) / 8)

export function estimateOutputBytes(
  project: { items: EstimateItem[] },
  quality: ExportQuality,
  probes: ReadonlyMap<string, StreamProbe> = new Map(),
  mode: 'concat' | 'separate' = 'concat'
): number {
  if (quality === 'copy') {
    let totalDur = 0
    for (const item of project.items) {
      const d = item.end - item.start
      if (Number.isFinite(d) && d > 0) totalDur += d
    }
    return Math.ceil(totalDur * COPY_BYTES_PER_SECOND)
  }
  const probeOf = (item: EstimateItem): StreamProbe | undefined => item.source === undefined ? undefined : probes.get(item.source)
  const spec = mode === 'concat'
    ? concatRenderSpec([...new Set(project.items.map((item) => item.source))].map((source) => source === undefined ? undefined : probes.get(source))).spec
    : undefined
  let totalBytes = 0
  for (const item of project.items) {
    const d = item.end - item.start
    if (!Number.isFinite(d) || d <= 0) continue
    const bps = preciseBytesPerSecond(spec ?? sourceSpec(probeOf(item)))
    totalBytes += d * bps
  }
  return Math.ceil(totalBytes)
}
