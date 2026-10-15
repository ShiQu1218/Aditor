import type { Clip } from './types'

/** 舊檔相容：缺 status 視為 accepted、缺 event_ids 補 []、去除重複 id（保留先出現者）。 */
export function normalizeClips(clips: Clip[] | undefined): Clip[] {
  const seen = new Set<string>()
  const out: Clip[] = []
  for (const c of clips ?? []) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push({ ...c, status: c.status ?? 'accepted', event_ids: c.event_ids ?? [] })
  }
  return out
}

/**
 * 重新分析合併規則（spec §4.2 擴充）：
 * manual 全留；已接受的 ai 保留並標 stale；suggested/skipped 的舊 ai 丟棄；
 * 新 ai 與保留片段起點差 < 1s 者不重複，其餘以 suggested 加入；依 start 排序。
 */
export function mergeOnReanalyze(oldClips: Clip[], newAi: Clip[]): Clip[] {
  const kept: Clip[] = []
  for (const c of normalizeClips(oldClips)) {
    if (c.origin === 'manual') kept.push(c)
    else if (c.status === 'accepted') kept.push({ ...c, stale: true })
  }
  const ids = new Set(kept.map((c) => c.id))
  const added: Clip[] = []
  for (const n of normalizeClips(newAi)) {
    if (n.origin !== 'ai') continue
    if (kept.some((k) => Math.abs(k.start - n.start) < 1)) continue
    // id 撞到保留片段時改發新 id，避免丟失建議
    let id = n.id
    while (ids.has(id)) id = `${id}_n`
    ids.add(id)
    const { stale: _stale, ...rest } = n
    added.push({ ...rest, id, status: 'suggested' })
  }
  return [...kept, ...added].sort((a, b) => a.start - b.start)
}

export function suggestionCount(clips: Clip[]): number {
  return clips.filter((c) => c.status === 'suggested').length
}
