// Keyboard dispatch: pure-function implementation of the spec §3.2.7 key × focus-zone matrix.
import { shellI18n } from '../i18n'
import type { TargetKind, Zone } from './focusZone'
import { tr } from '../../shared/locale'

export type { TargetKind, Zone }

export const COMMANDS = [
  'play',
  'speed',
  'prevEvent',
  'nextEvent',
  'seekBack',
  'seekFwd',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'quickOrSplit',
  'blade',
  'addEvent',
  'setStart',
  'setEnd',
  'addAllToProject',
  'acceptSuggestion',
  'skipSuggestion',
  'deleteProjectItem',
  'duplicateItem',
  'moveItemLeft',
  'moveItemRight',
  'playItem',
  'undo',
  'redo',
  'openExport',
  'toggleAside',
  'backToSource',
  'closeOverlay',
  'showShortcuts',
  'focusToast',
  'focusSearch',
  'toggleFavoriteFilter',
  'selectPrevItem',
  'selectNextItem',
  'listPrev',
  'listNext'
] as const
export type Command = (typeof COMMANDS)[number]

export interface KeyInput {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  repeat: boolean
  /** IME composition is active */
  isComposing?: boolean
  /** keydown during composition has keyCode 229 */
  keyCode?: number
}

export interface KeyCtx {
  screen: 'library' | 'studio' | 'settings'
  zone: Zone
  target: TargetKind
  mode: 'source' | 'project'
  overlayOpen: boolean
}

/** Ctrl/Cmd combinations (check Shift first). */
function resolveCtrl(e: KeyInput, ctx: KeyCtx): Command | null {
  if (e.altKey) return null
  const key = e.key.toLowerCase()

  // Library/settings: search and favorites filters only.
  if (ctx.screen !== 'studio') {
    if (e.shiftKey) return null
    if (key === 'f') return 'focusSearch'
    if (key === 'd' && ctx.screen === 'library') return 'toggleFavoriteFilter'
    return null
  }

  // 1) Check combinations with Shift before the same key without Shift.
  if (e.shiftKey) {
    if (key === 'z') return 'redo'
    if (key === 'e') return 'openExport'
    // On US keyboards Ctrl+Shift+= produces '+' and Ctrl+Shift+- produces '_'; treat both as zoom.
    if (e.key === '+') return 'zoomIn'
    if (e.key === '_') return 'zoomOut'
    return null
  }

  // 2) No Shift.
  switch (e.key) {
    case 'ArrowLeft':
      return 'prevEvent'
    case 'ArrowRight':
      return 'nextEvent'
    case '=':
    case '+':
      return 'zoomIn'
    case '-':
    case '_':
      return 'zoomOut'
    case '0':
      return 'zoomReset'
  }
  switch (key) {
    case 'z':
      return 'undo'
    case 'y':
      return 'redo'
    case 'e':
      return 'addAllToProject'
    case 'q':
      return 'quickOrSplit' // The caller chooses based on the source/project mode.
    case 'b':
      return 'toggleAside'
    case 'd':
      return ctx.zone === 'proj' ? 'duplicateItem' : null
  }
  return null
}

/** Commands that may repeat while held; ignore repeat for all others. */
const CONTINUOUS = new Set<Command>([
  'seekBack',
  'seekFwd',
  'zoomIn',
  'zoomOut',
  'undo',
  'redo',
  'prevEvent',
  'nextEvent',
  'moveItemLeft',
  'moveItemRight',
  'selectPrevItem',
  'selectNextItem',
  'listPrev',
  'listNext'
])

export function resolveKey(e: KeyInput, ctx: KeyCtx): Command | null {
  // Ignore all keys during IME composition, including keyCode 229.
  if (e.isComposing || e.keyCode === 229) return null
  // AltGr on Windows also sets ctrl+alt; it is not a shortcut.
  if (e.ctrlKey && e.altKey) return null
  const cmd = resolveInner(e, ctx)
  if (cmd && e.repeat && !CONTINUOUS.has(cmd)) return null
  return cmd
}

function resolveInner(e: KeyInput, ctx: KeyCtx): Command | null {
  const ctrl = e.ctrlKey || e.metaKey

  // When the studio has an overlay/dialog, only Esc (close the topmost one) may affect it.
  if (ctx.screen === 'studio' && ctx.overlayOpen) {
    return e.key === 'Escape' && !ctrl ? 'closeOverlay' : null
  }

  if (ctrl) return resolveCtrl(e, ctx)

  // Esc: overlays take priority; focused inputs/native controls must not return to the source (e.g. cancel IME composition).
  if (e.key === 'Escape') {
    if (ctx.overlayOpen) return 'closeOverlay'
    // Library: Esc clears search, including while the search field is focused.
    if (ctx.screen === 'library') return 'closeOverlay'
    // Settings: Esc clears search, including while focused; native controls such as dropdowns keep Esc.
    if (ctx.screen === 'settings') return ctx.target === 'native' ? null : 'closeOverlay'
    if (ctx.target !== 'none') return null
    if (ctx.screen !== 'studio') return null
    return ctx.mode === 'project' ? 'backToSource' : 'closeOverlay'
  }

  // Alt+T: focus the latest toast so Undo is reachable by keyboard, on any screen and even in inputs.
  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') return 'focusToast'

  if (ctx.screen === 'studio' && e.altKey) {
    // Alt+←/→: only in the project timeline; also works when inputs/native controls are focused (rule 1 excludes Ctrl/Alt).
    if (ctx.zone !== 'proj') return null
    if (e.key === 'ArrowLeft') return 'moveItemLeft'
    if (e.key === 'ArrowRight') return 'moveItemRight'
    return null
  }

  // Never intercept unmodified keys in inputs.
  if (ctx.target === 'text') return null

  // '?' may open help outside inputs, including on native controls.
  if (!e.altKey && e.key === '?') return 'showShortcuts'

  if (ctx.screen !== 'studio' || e.altKey) return null

  const native = ctx.target === 'native'
  const isSpace = e.code === 'Space' || e.key === ' '

  // Space always toggles playback in the studio; native controls keep Enter, arrow keys, and Delete.
  if (isSpace) return 'play'

  switch (e.key) {
    case 'Enter':
      if (native) return null
      if (ctx.zone === 'hl') return 'acceptSuggestion'
      if (ctx.zone === 'proj') return 'playItem'
      return null
    case 'Delete':
      if (native) return null
      if (ctx.zone === 'hl') return 'skipSuggestion'
      if (ctx.zone === 'proj') return 'deleteProjectItem'
      return null
    case 'ArrowLeft':
      if (native || e.shiftKey) return null
      if (ctx.zone === 'src') return 'seekBack'
      if (ctx.zone === 'proj') return 'selectPrevItem'
      return null
    case 'ArrowRight':
      if (native || e.shiftKey) return null
      if (ctx.zone === 'src') return 'seekFwd'
      if (ctx.zone === 'proj') return 'selectNextItem'
      return null
    case 'ArrowUp':
    case 'ArrowDown':
      if (native || e.shiftKey) return null
      if (ctx.zone !== 'hl') return null
      return e.key === 'ArrowUp' ? 'listPrev' : 'listNext'
    case '[':
      return 'setStart'
    case ']':
      return 'setEnd'
  }
  if (e.shiftKey) return null
  switch (e.key.toLowerCase()) {
    case 'b':
      return native ? null : 'blade'
    case 's':
      return 'speed'
    case 'm':
      return 'addEvent'
  }
  return null
}

export interface KeyRow {
  command: Command
  keys: string
  scope: string
  label: string
}

const S = shellI18n.keymap.scope
const row = (command: Command, keys: string, scope: string): KeyRow => ({
  command,
  keys,
  scope,
  label: shellI18n.keymap.cmd[command]
})

/** Shared table for shortcut help and tests: one row per command, with shared keys listed in `keys`. */
export const KEY_TABLE: KeyRow[] = [
  row('play', 'Space', S.studio),
  row('speed', 'S', S.studio),
  row('prevEvent', 'Ctrl+←', S.studio),
  row('nextEvent', 'Ctrl+→', S.studio),
  row('seekBack', '←', S.source),
  row('seekFwd', '→', S.source),
  row('zoomIn', `Ctrl+= ／ ${tr('滾輪')}`, S.studio),
  row('zoomOut', `Ctrl+- ／ ${tr('滾輪')}`, S.studio),
  row('zoomReset', 'Ctrl+0', S.studio),
  row('blade', 'B', S.studio),
  row('quickOrSplit', 'Ctrl+Q', S.studio),
  row('addEvent', 'M', S.studio),
  row('setStart', '[', S.studio),
  row('setEnd', ']', S.studio),
  row('addAllToProject', 'Ctrl+E', S.studio),
  row('acceptSuggestion', 'Enter', S.hl),
  row('skipSuggestion', 'Delete', S.hl),
  row('deleteProjectItem', 'Delete', S.proj),
  row('duplicateItem', 'Ctrl+D', S.proj),
  row('moveItemLeft', 'Alt+←', S.proj),
  row('moveItemRight', 'Alt+→', S.proj),
  row('playItem', 'Enter', S.proj),
  row('undo', 'Ctrl+Z', S.studio),
  row('redo', 'Ctrl+Y ／ Ctrl+Shift+Z', S.studio),
  row('openExport', 'Ctrl+Shift+E', S.studio),
  row('toggleAside', 'Ctrl+B', S.studio),
  row('backToSource', 'Esc', S.studio),
  row('closeOverlay', 'Esc', S.global),
  row('showShortcuts', '?', S.global),
  row('focusToast', 'Alt+T', S.global),
  row('focusSearch', 'Ctrl+F', tr('{library}／{settings}', { library: S.library, settings: S.settings })),
  row('toggleFavoriteFilter', 'Ctrl+D', S.library),
  row('selectPrevItem', '←', S.proj),
  row('selectNextItem', '→', S.proj),
  row('listPrev', '↑', S.hl),
  row('listNext', '↓', S.hl)
]
