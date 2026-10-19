// 鍵盤分派：spec §3.2.7「鍵 × 聚焦區」矩陣的純函式實作。
import { shellI18n } from '../i18n'
import type { TargetKind, Zone } from './focusZone'

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
  /** IME 組字中 */
  isComposing?: boolean
  /** 組字中的 keydown 為 229 */
  keyCode?: number
}

export interface KeyCtx {
  screen: 'library' | 'studio' | 'settings'
  zone: Zone
  target: TargetKind
  mode: 'source' | 'project'
  overlayOpen: boolean
}

/** Ctrl／Cmd 組合（含 Shift 的先判斷）。 */
function resolveCtrl(e: KeyInput, ctx: KeyCtx): Command | null {
  if (e.altKey) return null
  const key = e.key.toLowerCase()

  // 影片庫／設定：只有搜尋與收藏篩選
  if (ctx.screen !== 'studio') {
    if (e.shiftKey) return null
    if (key === 'f') return 'focusSearch'
    if (key === 'd' && ctx.screen === 'library') return 'toggleFavoriteFilter'
    return null
  }

  // 1) 含 Shift 的組合先於無 Shift 的同鍵
  if (e.shiftKey) {
    if (key === 'z') return 'redo'
    if (key === 'e') return 'openExport'
    // Ctrl+Shift+= 在美式鍵盤產生 '+'，Ctrl+Shift+- 產生 '_'：仍視為縮放
    if (e.key === '+') return 'zoomIn'
    if (e.key === '_') return 'zoomOut'
    return null
  }

  // 2) 無 Shift
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
      return 'quickOrSplit' // 來源／專案模式由執行端依 mode 決定
    case 'b':
      return 'toggleAside'
    case 'd':
      return ctx.zone === 'proj' ? 'duplicateItem' : null
  }
  return null
}

/** 長按時仍可連續觸發的指令；其餘指令 repeat 一律忽略。 */
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
  // IME 組字中（含 keyCode 229）一律不處理
  if (e.isComposing || e.keyCode === 229) return null
  // AltGr 在 Windows 會同時帶 ctrl+alt：不是快捷鍵
  if (e.ctrlKey && e.altKey) return null
  const cmd = resolveInner(e, ctx)
  if (cmd && e.repeat && !CONTINUOUS.has(cmd)) return null
  return cmd
}

function resolveInner(e: KeyInput, ctx: KeyCtx): Command | null {
  const ctrl = e.ctrlKey || e.metaKey

  // 工作室有浮層／對話框時，除了 Esc（關最上層）一律不作用於底下的工作室
  if (ctx.screen === 'studio' && ctx.overlayOpen) {
    return e.key === 'Escape' && !ctrl ? 'closeOverlay' : null
  }

  if (ctrl) return resolveCtrl(e, ctx)

  // Esc：浮層優先；焦點在輸入框／原生控制項時不得返回來源（例如取消 IME 組字）
  if (e.key === 'Escape') {
    if (ctx.overlayOpen) return 'closeOverlay'
    // 影片庫：Esc 清除搜尋（輸入框聚焦時亦可）
    if (ctx.screen === 'library') return 'closeOverlay'
    // 設定：Esc 清除搜尋（輸入框聚焦時亦可）；下拉選單等原生控制項保留 Esc
    if (ctx.screen === 'settings') return ctx.target === 'native' ? null : 'closeOverlay'
    if (ctx.target !== 'none') return null
    if (ctx.screen !== 'studio') return null
    return ctx.mode === 'project' ? 'backToSource' : 'closeOverlay'
  }

  // Alt+T：把焦點移到最新的 Toast（讓〔復原〕可由鍵盤直接到達；任何畫面、輸入框內也作用）
  if (e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') return 'focusToast'

  if (ctx.screen === 'studio' && e.altKey) {
    // Alt+←/→：只在專案軌，輸入框與原生控制項聚焦時也作用（規則 1：Ctrl/Alt 除外）
    if (ctx.zone !== 'proj') return null
    if (e.key === 'ArrowLeft') return 'moveItemLeft'
    if (e.key === 'ArrowRight') return 'moveItemRight'
    return null
  }

  // 輸入框一律不攔截無修飾鍵
  if (ctx.target === 'text') return null

  // '?' 在輸入框以外皆可開啟（原生控制項亦可）
  if (!e.altKey && e.key === '?') return 'showShortcuts'

  if (ctx.screen !== 'studio' || e.altKey) return null

  const native = ctx.target === 'native'
  const isSpace = e.code === 'Space' || e.key === ' '

  // 工作室 Space 一律播放；原生控制項保留 Enter／方向鍵／Delete
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

/** 「快捷鍵說明」與測試共用的資料表：每個 Command 恰一列（共用鍵以 keys 欄並列）。 */
export const KEY_TABLE: KeyRow[] = [
  row('play', 'Space', S.studio),
  row('speed', 'S', S.studio),
  row('prevEvent', 'Ctrl+←', S.studio),
  row('nextEvent', 'Ctrl+→', S.studio),
  row('seekBack', '←', S.source),
  row('seekFwd', '→', S.source),
  row('zoomIn', 'Ctrl+= ／ 滾輪', S.studio),
  row('zoomOut', 'Ctrl+- ／ 滾輪', S.studio),
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
  row('focusSearch', 'Ctrl+F', `${S.library}／${S.settings}`),
  row('toggleFavoriteFilter', 'Ctrl+D', S.library),
  row('selectPrevItem', '←', S.proj),
  row('selectNextItem', '→', S.proj),
  row('listPrev', '↑', S.hl),
  row('listNext', '↓', S.hl)
]
