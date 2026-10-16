import { Project } from '../editor/project'
import { SourceInfo } from './exportViewModel'

export interface ExportPlanBase {
  sources: Record<string, SourceInfo | undefined>
  keyframes: Record<string, number[] | undefined>
  missingItemIds: ReadonlySet<string>
}

interface ProbeResult {
  codec?: string
  width?: number
  height?: number
}

/**
 * 匯出抽屜開啟時收集每個來源影片的規格：目前開啟的影片用已載入的快取（含關鍵影格），
 * 其他來源以 `engine:probe` 各探測一次；來源缺失或探測失敗＝未知（不拿來判斷相容性，main 端匯出時仍會再驗證）。
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
          sources[src] = { codec: p.codec ?? '', width: p.width, height: p.height }
        }
      } catch {
        // 探測不到就視為未知
      }
    })
  )
  return { sources, keyframes, missingItemIds }
}
