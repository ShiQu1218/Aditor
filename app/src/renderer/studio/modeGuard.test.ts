import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { guardCommand, SOURCE_EDIT_COMMANDS } from './modeGuard'

describe('guardCommand (source-doc mutating commands in project mode)', () => {
  test.each(SOURCE_EDIT_COMMANDS)('%s: allowed in source mode, blocked in project mode', (cmd) => {
    expect(guardCommand('source', cmd)).toBe('allow')
    expect(guardCommand('project', cmd)).toBe('blocked')
  })
  test('covers add event, supercut, delete events, override', () => {
    for (const c of ['addEvent', 'supercut', 'deleteSelectedEvents', 'deleteEvent', 'setOverride']) {
      expect(SOURCE_EDIT_COMMANDS).toContain(c)
    }
  })
  test('non-edit commands are always allowed', () => {
    for (const c of ['play', 'undo', 'quickOrSplit', 'backToSource', 'playItem'] as const) {
      expect(guardCommand('project', c)).toBe('allow')
    }
  })
})

describe('toast actions in StudioScreen', () => {
  test('every toast action run is wrapped in guarded() except the project-only undo', () => {
    const src = readFileSync(join(__dirname, 'StudioScreen.tsx'), 'utf8')
    const runs = [...src.matchAll(/\brun:\s*([^\n]*)/g)].map((m) => m[1].trim())
    expect(runs.length).toBeGreaterThan(5)
    const unguarded = runs.filter((r) => !r.startsWith('guarded('))
    // 專案軌刪除片段的〔復原〕只動專案（undo），不碰來源文件
    // 匯出完成 Toast 的〔查看〕只開啟匯出抽屜（唯讀，不改來源文件）
    expect(unguarded.every((r) => /^undo\b/.test(r) || r.startsWith('() => setExportOpen(true)'))).toBe(true)
  })
})
