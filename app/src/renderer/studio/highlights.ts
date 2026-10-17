import type { CacheDoc, Clip, EngineEvent } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { mergeOnReanalyze, normalizeClips } from '../../shared/clips'
import type { AutoClipParams } from '../../shared/types'
import { addItems, type Project, type ProjectItem } from '../editor/project'
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
 * 「套用（取代現有建議）」：只取代 suggested 的 AI 片段；手動、已加入與已略過的片段全部保留
 * （使用者的略過不會被重設）。與保留片段（含已略過）起點 <1s 的新建議不重複、id 撞號改發新 id。
 */
export function applyAutoClip(oldClips: Clip[], newClips: Clip[]): Clip[] {
  const kept = normalizeClips(oldClips).filter((c) => !(c.origin === 'ai' && c.status === 'suggested'))
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

const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

/**
 * 顯示用狀態：「已加入」以專案實際內容為準。專案中沒有同來源且時段重疊的片段
 * （從專案區刪除、開新專案、復原加入…）時，已加入的片段顯示回建議，可再次加入。
 * 用重疊而非起訖相同，片軌把手修剪過的專案片段仍算已加入。未變動者保留原物件。
 */
export function withProjectStatus(clips: Clip[], source: string, project: Project): Clip[] {
  const src = normPath(source)
  const ranges = project.items.filter((it) => normPath(it.source) === src)
  return clips.map((c) => {
    if ((c.status ?? 'accepted') !== 'accepted') return c
    const inProject = ranges.some((it) => it.start < c.end && it.end > c.start)
    return inProject ? c : { ...c, status: 'suggested' }
  })
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

export interface AddAllPlan {
  project: Project
  /** 本次實際新增的專案片段 id（空＝沒有新增，呼叫端不應推歷史／Toast） */
  addedIds: string[]
}

/** 全部加入（Ctrl+E）：逐一以幂等的 acceptToProject 加入；重複觸發不會產生重複片段。 */
export function planAddAll(suggested: Clip[], source: string, project: Project): AddAllPlan {
  let next = project
  const addedIds: string[] = []
  for (const c of suggested) {
    const res = acceptToProject(c, source, next)
    if (res.added.length > 0) next = { ...next, items: [...next.items, ...res.added] }
    for (const it of res.added) addedIds.push(it.id)
  }
  return { project: addedIds.length > 0 ? next : project, addedIds }
}

export interface AcceptPlan {
  /** 套用後的專案（沒有新增時就是原物件） */
  project: Project
  /** 卡片的新狀態 */
  clipStatus: 'accepted'
  /** 'added'＝實際新增；'duplicate'＝專案已有此片段（顯示資訊 Toast、不附復原） */
  notice: 'added' | 'duplicate'
  /** 復原動作（duplicate 時為 null）：移除本次加入的專案片段，並讓卡片回到原狀態（Enter 可再次加入） */
  undo: { project: (p: Project) => Project; clipStatus: 'suggested' | 'accepted' } | null
}

/** 單張卡片「加入」（卡片／Enter／＋從來源加入）的純規劃：專案變更、卡片狀態、Toast 復原內容（spec §3.6）。 */
export function planAccept(clip: Clip, source: string, project: Project): AcceptPlan {
  const res = acceptToProject(clip, source, project)
  if (res.added.length === 0) {
    return { project, clipStatus: 'accepted', notice: 'duplicate', undo: null }
  }
  return {
    project: addItems(project, res.added),
    clipStatus: 'accepted',
    notice: 'added',
    undo: { project: res.undo, clipStatus: clip.status === 'suggested' ? 'suggested' : 'accepted' }
  }
}

export type SuggestionPlan =
  | { kind: 'none' }
  /** 載入路徑：文件沒有 AI 片段，放置新建議 */
  | { kind: 'place'; params: AutoClipParams }
  /** 重新分析：重跑 autoclip 並以 mergeOnReanalyze 合併（accepted→stale、舊建議丟棄） */
  | { kind: 'merge'; params: AutoClipParams }

export interface SuggestionInput {
  doc: CacheDoc
  /** 目前（重新分析前）的片段 */
  clips: Clip[]
  settings: { autoSuggestOnOpen: boolean; autoclip: AutoClipParams }
  /**
   * 這次文件是否為重新分析的結果。預設取自文件旗標 `doc.app.suggestionsPending`
   * （main 在重新分析完成後寫入；引擎文件本身看不出來）。
   */
  reanalyzed?: boolean
}

/** 文件是否帶有「重新分析後建議尚未重算」旗標（main 寫入；工作室合併一次後清除）。 */
export function isSuggestionsPending(doc: Pick<CacheDoc, 'app'>): boolean {
  return Boolean(doc.app?.suggestionsPending)
}

/**
 * 分析完成後是否／如何產生建議。引擎 analyze 的文件只含手動片段（engine/apexhl/analyze.py），
 * main 在重新分析後把手動＋已加入（stale）的片段寫回並設 `app.suggestionsPending`，
 * 所以帶旗標的文件一律以目前預設參數重跑 autoclip 並 mergeOnReanalyze；
 * 單純載入（首次分析、無旗標）則維持 shouldAutoPlace 規則（不標 stale）。
 */
export function planSuggestions(input: SuggestionInput): SuggestionPlan {
  const { doc, settings } = input
  const reanalyzed = input.reanalyzed ?? isSuggestionsPending(doc)
  if (doc.analysis?.status !== 'done' || doc.events.length === 0) return { kind: 'none' }
  if (reanalyzed) return { kind: 'merge', params: settings.autoclip }
  if (shouldAutoPlace(doc, settings)) return { kind: 'place', params: settings.autoclip }
  return { kind: 'none' }
}

/** 把 autoclip 新結果合併進目前片段（'merge'＝mergeOnReanalyze；'place'＝保留手動、加入建議）。 */
export function mergeSuggestions(kind: 'place' | 'merge', current: Clip[], freshAi: Clip[]): Clip[] {
  if (kind === 'merge') return mergeOnReanalyze(current, freshAi)
  const manual = normalizeClips(current).filter((c) => c.origin === 'manual')
  return [...manual, ...toSuggestions(freshAi)].sort((a, b) => a.start - b.start)
}
