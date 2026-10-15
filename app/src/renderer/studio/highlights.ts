import type { CacheDoc, Clip, EngineEvent } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { normalizeClips } from '../../shared/clips'
import type { Project, ProjectItem } from '../editor/project'
import { i18n } from '../i18n/zh-TW'

/**
 * 精華分頁的純函式（spec §3.2.3、§3.2.4、§3.6）：
 * 自動放置判定、建議狀態轉換、浮層套用合併、加入專案（含復原）、標題與事件字形。
 */

/** 開啟影片時是否自動放置 AI 建議框：設定開啟、分析完成且文件中沒有任何 AI 片段（spec §3.2.6）。 */
export function shouldAutoPlace(doc: CacheDoc, settings: { autoSuggestOnOpen: boolean }): boolean {
  return (
    Boolean(settings.autoSuggestOnOpen) &&
    doc.analysis?.status === 'done' &&
    !(doc.clips ?? []).some((c) => c.origin === 'ai')
  )
}

/** 引擎 autoclip 輸出 → 建議狀態片段（origin 與區間原樣保留）。 */
export function toSuggestions(clips: Clip[]): Clip[] {
  return normalizeClips(clips).map((c) => ({ ...c, status: 'suggested' as const }))
}

/**
 * 「套用（取代現有建議）」：保留手動與已加入片段，suggested／skipped 的 AI 片段被新結果取代
 * （mergeOnReanalyze 的子集規則：與保留片段起點 <1s 的新建議不重複、id 撞號改發新 id）。
 */
export function applyAutoClip(oldClips: Clip[], newClips: Clip[]): Clip[] {
  const kept = normalizeClips(oldClips).filter((c) => c.origin === 'manual' || c.status === 'accepted')
  const ids = new Set(kept.map((c) => c.id))
  const added: Clip[] = []
  for (const n of normalizeClips(newClips)) {
    if (n.origin !== 'ai') continue
    if (kept.some((k) => Math.abs(k.start - n.start) < 1)) continue
    let id = n.id
    while (ids.has(id)) id = `${id}_n`
    ids.add(id)
    const { stale: _stale, ...rest } = n
    added.push({ ...rest, id, status: 'suggested' })
  }
  return [...kept, ...added].sort((a, b) => a.start - b.start)
}

/** 依 id 移除專案片段（回傳新專案）。 */
export function removeProjectItems(project: Project, ids: string[]): Project {
  if (ids.length === 0) return project
  const set = new Set(ids)
  return { ...project, items: project.items.filter((i) => !set.has(i.id)) }
}

export interface AcceptResult {
  /** 本次實際新增的片段（已存在相同來源＋時段＝空陣列，呼叫端據此判斷重複）。 */
  added: ProjectItem[]
  /** 復原：只移除本次加入的片段（可套用於當下最新的專案狀態）。 */
  undo: (project: Project) => Project
}

const SAME_EPS = 1e-3

/** 同來源且起訖幾乎相同＝同一片段（避免重複加入）。 */
function sameItem(item: ProjectItem, source: string, clip: Clip): boolean {
  return (
    item.source === source &&
    Math.abs(item.start - clip.start) < SAME_EPS &&
    Math.abs(item.end - clip.end) < SAME_EPS
  )
}

function newItemId(): string {
  return `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

/** 專案中對應此片段的項目 id（來源＋起訖相同＝同一片段）。 */
export function findItemsForClip(clip: Clip, source: string, project: Project): string[] {
  return project.items.filter((it) => sameItem(it, source, clip)).map((it) => it.id)
}

/**
 * 把片段加入專案（spec §3.6）：重複加入為幂等（回傳空 `added`）；
 * 回傳的 `undo` 只移除本次加入的片段，供 Toast〔復原〕使用。
 */
export function acceptToProject(clip: Clip, source: string, project: Project): AcceptResult {
  if (project.items.some((it) => sameItem(it, source, clip))) {
    return { added: [], undo: (p) => p }
  }
  const item: ProjectItem = { id: newItemId(), source, start: clip.start, end: clip.end }
  const ids = [item.id]
  return {
    added: [item],
    undo: (p) => removeProjectItems(p, ids)
  }
}

/** 片段指向的事件（依事件清單順序；找不到者略過）。 */
function eventsOfClip(clip: Clip, events: EngineEvent[]): EngineEvent[] {
  const ids = new Set(clip.event_ids ?? [])
  return events.filter((e) => ids.has(e.id))
}

/** 片段內計入的事件數（軟刪除與 override 由 isCounted 統一判定）。 */
export function countedEventCount(clip: Clip, events: EngineEvent[]): number {
  return eventsOfClip(clip, events).filter((e) => isCounted(e)).length
}

/** 卡片標題：「N 殺精華」／手動「快速剪輯」／沒有計入事件「精華片段」。 */
export function clipTitle(clip: Clip, events: EngineEvent[]): string {
  const t = i18n.studio.hl
  if (clip.origin === 'manual') return t.quickTitle
  const n = countedEventCount(clip, events)
  return n > 0 ? t.title.replace('{n}', String(n)) : t.genericTitle
}

export interface ClipGlyph {
  type: string
  counted: boolean
}

export interface ClipGlyphRow {
  /** 上限內的字形（不計入者淡色顯示）。 */
  glyphs: ClipGlyph[]
  /** 超過上限未顯示的事件數（顯示「+N」）。 */
  overflow: number
}

/** 事件字形列：最多 max 個，超過顯示 +N；不計入者標記為淡色。 */
export function clipEventGlyphs(clip: Clip, events: EngineEvent[], max = 12): ClipGlyphRow {
  const all = eventsOfClip(clip, events)
  const glyphs = all.slice(0, max).map((e) => ({ type: e.type, counted: isCounted(e) }))
  return { glyphs, overflow: Math.max(0, all.length - glyphs.length) }
}

/**
 * 是否仍是待確認建議（status 缺省＝舊檔視為已加入）。
 */
export function isSuggested(clip: Clip): boolean {
  return clip.origin === 'ai' && (clip.status ?? 'accepted') === 'suggested'
}

/**
 * 目前作用中的建議（`Enter` 加入、`Delete` 略過、`↑↓` 移動用）：
 * 跳過已加入／已略過與 status 缺省（舊檔視為已加入）者；找不到下一個時環繞。
 */
export function nextSuggestion(clips: Clip[], activeId: string | null, dir: 1 | -1 = 1): string | null {
  if (clips.length === 0) return null
  const at = activeId ? clips.findIndex((c) => c.id === activeId) : -1
  for (let step = 1; step <= clips.length; step++) {
    const base = at >= 0 ? at : dir === 1 ? -1 : 0
    const i = (((base + dir * step) % clips.length) + clips.length) % clips.length
    if (isSuggested(clips[i])) return clips[i].id
  }
  return null
}
