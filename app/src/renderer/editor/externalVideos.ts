import type { LibraryEntry } from '../../main/library'
import type { QueuePayload } from '../../shared/queueState'
import type { ProjectItem } from './project'

interface ExternalVideoApi {
  library: { add: (paths: string[]) => Promise<unknown>; getEntries: () => Promise<LibraryEntry[]> }
  queue: { enqueue: (path: string) => Promise<unknown>; getState: () => Promise<QueuePayload> }
  engine: { probe: (path: string) => Promise<{ duration: number } | null> }
}

const norm = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

/** 加入影片庫與分析佇列後探測長度；個別失敗不撤回影片庫，也不影響其他影片。 */
export async function importExternalVideos(paths: string[], api: ExternalVideoApi): Promise<{
  items: Omit<ProjectItem, 'id'>[]
  failed: string[]
}> {
  const unique = [...new Map(paths.map((path) => [norm(path), path])).values()]
  await api.library.add(unique)
  const [entries, { queue }] = await Promise.all([api.library.getEntries(), api.queue.getState()])
  const busy = new Set([...(queue.queued ?? []), ...(queue.analyzing ? [queue.analyzing] : [])].map(norm))
  const items: Omit<ProjectItem, 'id'>[] = []
  const failed: string[] = []
  for (const source of unique) {
    const entry = entries.find((e) => norm(e.path) === norm(source))
    try {
      // library:add 已自動排程；完成／分析中／已排隊的影片不可再分析。
      if (entry?.status !== 'done' && entry?.status !== 'analyzing' && !busy.has(norm(source))) {
        await api.queue.enqueue(source)
      }
    } catch {
      failed.push(source)
    }
    try {
      const duration = entry?.durationSec || (await api.engine.probe(source))?.duration
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('duration')
      items.push({ source, start: 0, end: duration })
    } catch {
      if (!failed.includes(source)) failed.push(source)
    }
  }
  return { items, failed }
}
