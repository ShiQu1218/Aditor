// 鍵盤分派：spec §3.2.7「鍵 × 聚焦區」矩陣的純函式實作。
import { shellI18n } from '../i18n/zh-TW'
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
  'addEvent',
  'setStart',
  'setEnd',
  'supercut',
  'addAllToProject',
  'acceptSuggestion',
  'skipSuggestion',
  'deleteSelectedEvents',
  'deleteProjectItem',
  'duplicateItem',
  'moveItemLeft',
  'moveItemRight',
  'playItem',
  'undo',
  'redo',
  'saveProjectFile',
  'openExport',
  'toggleAside',
  'backToSource',
  'closeOverlay',
  'showShortcuts',
  'focusSearch',
  'toggleFavoriteFilter'
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
    case 's':
      return 'saveProjectFile'
    case 'e':
      return 'addAllToProject'
    case 'q':
      return 'quickOrSplit' // 來源／專案模式由執行端依 mode 決定
    case 'm':
      return 'supercut'
    case 'b':
      return 'toggleAside'
    case 'd':
      return ctx.zone === 'proj' ? 'duplicateItem' : null
  }
  return null
}

export function resolveKey(e: KeyInput, ctx: KeyCtx): Command | null {
  const ctrl = e.ctrlKey || e.metaKey

  if (ctrl) return resolveCtrl(e, ctx)

  // Esc：浮層優先，其次專案模式返回來源，否則清除選取／關閉抽屜
  if (e.key === 'Escape') {
    if (ctx.overlayOpen) return 'closeOverlay'
    if (ctx.screen !== 'studio') return null
    return ctx.mode === 'project' ? 'backToSource' : 'closeOverlay'
  }

  // 輸入框一律不攔截無修飾鍵（含 Alt 組合）
  if (ctx.target === 'text') return null

  // '?' 在輸入框以外皆可開啟（原生控制項亦可）
  if (e.key === '?') return 'showShortcuts'

  if (ctx.screen !== 'studio') return null

  // Alt+←/→：只在專案軌，原生控制項聚焦時也作用
  if (e.altKey) {
    if (ctx.zone !== 'proj') return null
    if (e.key === 'ArrowLeft') return 'moveItemLeft'
    if (e.key === 'ArrowRight') return 'moveItemRight'
    return null
  }

  const native = ctx.target === 'native'
  const isSpace = e.code === 'Space' || e.key === ' '

  // 原生控制項保留 Space／Enter／方向鍵／Delete
  if (isSpace) return native || e.repeat ? null : 'play'

  switch (e.key) {
    case 'Enter':
      if (native || e.repeat) return null
      if (ctx.zone === 'hl') return 'acceptSuggestion'
      if (ctx.zone === 'proj') return 'playItem'
      return null // 事件清單的「跳到選取事件」由清單自身處理，來源軌無作用
    case 'Delete':
      if (native || e.repeat) return null
      if (ctx.zone === 'hl') return 'skipSuggestion'
      if (ctx.zone === 'ev') return 'deleteSelectedEvents'
      if (ctx.zone === 'proj') return 'deleteProjectItem'
      return null
    case 'ArrowLeft':
      return !native && ctx.zone === 'src' ? 'seekBack' : null
    case 'ArrowRight':
      return !native && ctx.zone === 'src' ? 'seekFwd' : null
    case '[':
      return e.repeat ? null : 'setStart'
    case ']':
      return e.repeat ? null : 'setEnd'
  }
  if (e.shiftKey) return null
  switch (e.key.toLowerCase()) {
    case 's':
      return e.repeat ? null : 'speed'
    case 'm':
      return e.repeat ? null : 'addEvent'
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
  row('zoomIn', 'Ctrl+= ／ Ctrl+滾輪', S.studio),
  row('zoomOut', 'Ctrl+-', S.studio),
  row('zoomReset', 'Ctrl+0', S.studio),
  row('quickOrSplit', 'Ctrl+Q', S.studio),
  row('addEvent', 'M', S.studio),
  row('setStart', '[', S.studio),
  row('setEnd', ']', S.studio),
  row('supercut', 'Ctrl+M', S.studio),
  row('addAllToProject', 'Ctrl+E', S.studio),
  row('acceptSuggestion', 'Enter', S.hl),
  row('skipSuggestion', 'Delete', S.hl),
  row('deleteSelectedEvents', 'Delete', S.ev),
  row('deleteProjectItem', 'Delete', S.proj),
  row('duplicateItem', 'Ctrl+D', S.proj),
  row('moveItemLeft', 'Alt+←', S.proj),
  row('moveItemRight', 'Alt+→', S.proj),
  row('playItem', 'Enter', S.proj),
  row('undo', 'Ctrl+Z', S.studio),
  row('redo', 'Ctrl+Y ／ Ctrl+Shift+Z', S.studio),
  row('saveProjectFile', 'Ctrl+S', S.studio),
  row('openExport', 'Ctrl+Shift+E', S.studio),
  row('toggleAside', 'Ctrl+B', S.studio),
  row('backToSource', 'Esc', S.studio),
  row('closeOverlay', 'Esc', S.global),
  row('showShortcuts', '?', S.global),
  row('focusSearch', 'Ctrl+F', `${S.library}／${S.settings}`),
  row('toggleFavoriteFilter', 'Ctrl+D', S.library)
]
