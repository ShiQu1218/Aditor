import type { CacheDoc, Clip, EngineEvent } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { mergeOnReanalyze, normalizeClips } from '../../shared/clips'
import type { AutoClipParams } from '../../shared/types'
import { addItems, type Project, type ProjectItem } from '../editor/project'
import { i18n } from '../i18n'

/**
 * Pure functions for the highlights tab (spec §3.2.3, §3.2.4, §3.6):
 * automatic placement, suggestion state transitions, popover merge, adding clips to a project (including undo), titles, and event glyphs.
 */

/** Whether to place AI suggestions automatically on open: enabled in settings, analysis is complete, and the document has no AI clips (spec §3.2.6). */
export function shouldAutoPlace(doc: CacheDoc, settings: { autoSuggestOnOpen: boolean }): boolean {
  return (
    Boolean(settings.autoSuggestOnOpen) &&
    doc.analysis?.status === 'done' &&
    !(doc.clips ?? []).some((c) => c.origin === 'ai')
  )
}

/** Convert engine autoclip output to suggested clips (preserve origin and intervals as-is). */
export function toSuggestions(clips: Clip[]): Clip[] {
  return normalizeClips(clips).map((c) => ({ ...c, status: 'suggested' as const }))
}

/**
 * Apply (replace existing suggestions): replace only suggested AI clips; keep manual, added, and skipped clips
 * (user skips are not reset). Avoid new suggestions starting within 1s of retained clips (including skipped ones), and generate a new id for collisions.
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

/** Remove project clips by id and return a new project. */
export function removeProjectItems(project: Project, ids: string[]): Project {
  if (ids.length === 0) return project
  const set = new Set(ids)
  return { ...project, items: project.items.filter((i) => !set.has(i.id)) }
}

export interface AcceptResult {
  /** Clips actually added this time (empty if the same source and interval already exist, which callers use to detect duplicates). */
  added: ProjectItem[]
  /** Undo by removing only the clips added this time (can be applied to the latest project state). */
  undo: (project: Project) => Project
}

const SAME_EPS = 1e-3

/** Same source and nearly identical start/end times means the same clip (prevents duplicates). */
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

/** Find the project item id for this clip (same source and interval means the same clip). */
export function findItemsForClip(clip: Clip, source: string, project: Project): string[] {
  return project.items.filter((it) => sameItem(it, source, clip)).map((it) => it.id)
}

/**
 * Add clips to the project (spec §3.6): duplicate additions are idempotent (return empty `added`).
 * The returned `undo` removes only clips added this time for use by the Toast Undo action.
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

/** Events referenced by a clip, in event-list order; skip events that cannot be found. */
function eventsOfClip(clip: Clip, events: EngineEvent[]): EngineEvent[] {
  const ids = new Set(clip.event_ids ?? [])
  return events.filter((e) => ids.has(e.id))
}

/** Number of counted events in a clip (isCounted handles soft deletion and overrides). */
export function countedEventCount(clip: Clip, events: EngineEvent[]): number {
  return eventsOfClip(clip, events).filter((e) => isCounted(e)).length
}

/** Card title: “N-kill highlight,” “Quick Clip” for manual clips, or “Highlight Clip” when there are no counted events. */
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
  /** Glyphs within the limit (uncounted events appear dimmed). */
  glyphs: ClipGlyph[]
  /** Number of events beyond the limit (displayed as “+N”). */
  overflow: number
}

/** Event glyph row: show at most max glyphs, then +N; mark uncounted events as dimmed. */
export function clipEventGlyphs(clip: Clip, events: EngineEvent[], max = 12): ClipGlyphRow {
  const all = eventsOfClip(clip, events)
  const glyphs = all.slice(0, max).map((e) => ({ type: e.type, counted: isCounted(e) }))
  return { glyphs, overflow: Math.max(0, all.length - glyphs.length) }
}

/**
 * Whether this is still a pending suggestion (missing status in legacy files means added).
 */
export function isSuggested(clip: Clip): boolean {
  return clip.origin === 'ai' && (clip.status ?? 'accepted') === 'suggested'
}

const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

/**
 * Display status: determine “added” from actual project content. If no clip from the same source overlaps in time
 * (deleted from the project, a new project was opened, an addition was undone, etc.), show it as suggested so it can be added again.
 * Use overlap instead of exact bounds so project clips trimmed with track handles still count as added. Preserve unchanged objects.
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
 * Current active suggestion (used by `Enter` to add, `Delete` to skip, and `↑↓` to move):
 * Skip added, skipped, and missing-status clips (legacy files treat them as added); wrap when no next item is found.
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

/** Clip whose source range contains playhead t (on overlap, the one starting latest); null when t is outside every clip. */
export function clipAt(clips: Clip[], t: number): string | null {
  let hit: Clip | null = null
  for (const c of clips) {
    if (t >= c.start && t <= c.end && (!hit || c.start > hit.start)) hit = c
  }
  return hit?.id ?? null
}

export interface AddAllPlan {
  project: Project
  /** Project clip ids actually added this time (empty means nothing changed; callers should not push history or show a Toast). */
  addedIds: string[]
}

/** Add all (Ctrl+E): add each with idempotent acceptToProject; repeated calls do not create duplicate clips. */
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
  /** Project after applying (the original object when nothing was added). */
  project: Project
  /** New card status. */
  clipStatus: 'accepted'
  /** 'added' means a clip was added; 'duplicate' means it already exists (show an informational Toast without Undo). */
  notice: 'added' | 'duplicate'
  /** Undo action (null for duplicates): remove the project clip added this time and restore the card's prior state so Enter can add it again. */
  undo: { project: (p: Project) => Project; clipStatus: 'suggested' | 'accepted' } | null
}

/** Pure plan for adding one card (card/Enter/Add from Source): project change, card status, and Toast Undo content (spec §3.6). */
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
  /** Load path: the document has no AI clips; place new suggestions. */
  | { kind: 'place'; params: AutoClipParams }
  /** Reanalysis: rerun autoclip and merge with mergeOnReanalyze (accepted → stale; discard old suggestions). */
  | { kind: 'merge'; params: AutoClipParams }

export interface SuggestionInput {
  doc: CacheDoc
  /** Current clips (before reanalysis). */
  clips: Clip[]
  settings: { autoSuggestOnOpen: boolean; autoclip: AutoClipParams }
  /**
   * Whether this document is the result of reanalysis. Defaults to the document flag `doc.app.suggestionsPending`
   * (written by main after reanalysis; the engine document does not indicate this on its own).
   */
  reanalyzed?: boolean
}

/** Whether the document has the “suggestions pending after reanalysis” flag (written by main and cleared after one studio merge). */
export function isSuggestionsPending(doc: Pick<CacheDoc, 'app'>): boolean {
  return Boolean(doc.app?.suggestionsPending)
}

/**
 * Whether and how to generate suggestions after analysis. The engine's analyze document contains manual clips only (engine/aditor/analyze.py).
 * After reanalysis, main writes back manual and accepted (stale) clips and sets `app.suggestionsPending`,
 * so flagged documents always rerun autoclip with the current defaults and use mergeOnReanalyze.
 * A normal load (first analysis, no flag) follows shouldAutoPlace and does not mark clips stale.
 */
export function planSuggestions(input: SuggestionInput): SuggestionPlan {
  const { doc, settings } = input
  const reanalyzed = input.reanalyzed ?? isSuggestionsPending(doc)
  if (doc.analysis?.status !== 'done' || doc.events.length === 0) return { kind: 'none' }
  if (reanalyzed) return { kind: 'merge', params: settings.autoclip }
  if (shouldAutoPlace(doc, settings)) return { kind: 'place', params: settings.autoclip }
  return { kind: 'none' }
}

/** Merge new autoclip results into current clips ('merge' uses mergeOnReanalyze; 'place' keeps manual clips and adds suggestions). */
export function mergeSuggestions(kind: 'place' | 'merge', current: Clip[], freshAi: Clip[]): Clip[] {
  if (kind === 'merge') return mergeOnReanalyze(current, freshAi)
  const manual = normalizeClips(current).filter((c) => c.origin === 'manual')
  return [...manual, ...toSuggestions(freshAi)].sort((a, b) => a.start - b.start)
}
