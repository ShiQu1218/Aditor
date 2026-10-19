import { Project } from '../editor/project'
import { concatCompatible, extraSecondsForCopy, StreamProbe } from '../../shared/exportCompat'
import { i18n } from '../i18n'
import { tr } from '../../shared/locale'

/** Source video metadata (returned by engine:probe); main uses defaults for other stream parameters, so compare only these three. */
export interface SourceInfo {
  codec: string
  width: number
  height: number
}

export interface ExportPlan {
  mode: 'concat' | 'separate'
  quality: 'copy' | 'precise'
/** Keyed by source path; omit sources that could not be probed (treat as unknown and do not use to detect mismatches). */
  sources: Record<string, SourceInfo | undefined>
/** Keyframe times keyed by source path (currently available only for the analyzed current video). */
  keyframes: Record<string, number[] | undefined>
/** IDs of clips with missing sources (ProjectProvider.missingItemIds). */
  missingItemIds: ReadonlySet<string>
}

export interface Notice {
  kind: 'info' | 'warn'
  text: string
}

export interface ExportEncoders {
  encoders: string[]
/** Whether the OpenH264 DLL is installed. */
  openh264: boolean
}

export interface ExportViewModel {
  notices: Notice[]
  copyAvailable: boolean
/** Average extra seconds at each clip start for fast lossless; null for other modes or without keyframe data (never fabricate a number). */
  extraSecondsHint: number | null
  canStart: boolean
  blockers: string[]
/** Quality that will actually be used (fast lossless automatically switches to precise for a merged export with mismatched sources). */
  effectiveQuality: 'copy' | 'precise'
/** Whether OpenH264 must be acquired first (precise re-encoding, no available encoder, and not already installed). */
  openh264Required: boolean
}

function toProbe(i: SourceInfo): StreamProbe {
  // Engine probe does not provide frame rate, pixel format, or audio metadata; use 0/empty string for unknown (see concatCompatible).
  return { vcodec: i.codec, width: i.width, height: i.height, fps: 0, pix_fmt: '', acodec: '', sample_rate: 0, channels: 0 }
}

/** Derived state for the export settings page (pure function). Reuse shared/exportCompat for compatibility checks, the same logic as main's buildJobs. */
export function exportViewModel(project: Project, plan: ExportPlan | null, enc: ExportEncoders): ExportViewModel {
  const t = i18n.export
  const notices: Notice[] = []
  const blockers: string[] = []
  const items = project.items

  if (items.length === 0) blockers.push(t.blockEmpty)

  const missingSources: string[] = []
  if (plan) {
    for (const it of items) {
      if (plan.missingItemIds.has(it.id) && !missingSources.includes(it.source)) missingSources.push(it.source)
    }
  }
  for (const s of missingSources) blockers.push(t.blockMissingSource.replace('{path}', s))

  let copyAvailable = true
  if (plan && plan.mode === 'concat') {
    const probes: StreamProbe[] = []
  // Probe each source only once (duplicate clips from one video are already compatible).
    for (const src of new Set(items.map((it) => it.source))) {
      const info = plan.sources[src]
      if (info) probes.push(toProbe(info))
    }
    const check = concatCompatible(probes)
    if (!check.ok) {
      copyAvailable = false
      if (plan.quality === 'copy') {
        notices.push({ kind: 'warn', text: tr('{label}（{detail}）', { label: t.fallbackReencodeNotice, detail: check.reason }) })
      }
    }
  }

  const effectiveQuality: 'copy' | 'precise' = plan && plan.quality === 'copy' && copyAvailable ? 'copy' : 'precise'

  let extraSecondsHint: number | null = null
  if (plan && effectiveQuality === 'copy') {
    const gaps: number[] = []
    for (const it of items) {
      const kf = plan.keyframes[it.source]
      if (kf && kf.length > 0) gaps.push(extraSecondsForCopy(it.start, kf))
    }
    if (gaps.length > 0) extraSecondsHint = gaps.reduce((a, b) => a + b, 0) / gaps.length
  }

  const needsEncoder = plan !== null && effectiveQuality === 'precise'
  const noEncoder = enc.encoders.length === 0
  const openh264Required = needsEncoder && noEncoder && !enc.openh264
  if (needsEncoder && noEncoder && enc.openh264) blockers.push(t.blockNoEncoder)

  const canStart = plan !== null && items.length > 0 && missingSources.length === 0 && !(needsEncoder && noEncoder)
  return { notices, copyAvailable, extraSecondsHint, canStart, blockers, effectiveQuality, openh264Required }
}

/** Format bytes as e.g. "1.6 GB" or "212 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 MB'
  const gb = n / 1024 ** 3
  if (gb >= 1) return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
}

/** Whether remaining disk space is insufficient (estimated size × 1.1, same threshold as main's checkDiskSpace). */
export function diskIsLow(freeBytes: number, estimateBytes: number): boolean {
  return freeBytes < estimateBytes * 1.1
}
