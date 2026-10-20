import { Project } from '../editor/project'
import { SourceInfo } from './exportViewModel'

export interface ExportPlanBase {
  sources: Record<string, SourceInfo | undefined>
  keyframes: Record<string, number[] | undefined>
  missingItemIds: ReadonlySet<string>
}

type ProbeResult = Partial<SourceInfo>

/**
 * Collect metadata for each source video when the export drawer opens: use the loaded cache (including keyframes) for the current video,
 * and probe each other source once with `engine:probe`; missing sources or probe failures are unknown (do not use them for compatibility checks; main validates again during export).
 */
export async function buildPlanBase(
  project: Project,
  missingItemIds: ReadonlySet<string>,
  current: { path: string; info: SourceInfo; keyframes: number[] },
  probe: (path: string) => Promise<ProbeResult | null | undefined>
): Promise<ExportPlanBase> {
  const sources: ExportPlanBase['sources'] = {}
  const keyframes: ExportPlanBase['keyframes'] = {}
  const missingSources = new Set(project.items.filter((i) => missingItemIds.has(i.id)).map((i) => i.source))
  const distinct = [...new Set(project.items.map((i) => i.source))]
  await Promise.all(
    distinct.map(async (src) => {
      if (src === current.path) {
        sources[src] = current.info
        keyframes[src] = current.keyframes
        return
      }
      if (missingSources.has(src)) return
      try {
        const p = await probe(src)
        if (p && typeof p.width === 'number' && typeof p.height === 'number') {
          sources[src] = { codec: p.codec ?? '', width: p.width, height: p.height, fps: p.fps, pix_fmt: p.pix_fmt, acodec: p.acodec, sample_rate: p.sample_rate, channels: p.channels }
        }
      } catch {
  // Treat sources that cannot be probed as unknown.
      }
    })
  )
  return { sources, keyframes, missingItemIds }
}
