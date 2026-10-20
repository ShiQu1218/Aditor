import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { guardCommand, SOURCE_EDIT_COMMANDS } from './modeGuard'

describe('guardCommand (source-doc mutating commands in project mode)', () => {
  test.each(SOURCE_EDIT_COMMANDS)('%s: allowed in source mode, blocked in project mode', (cmd) => {
    expect(guardCommand('source', cmd)).toBe('allow')
    expect(guardCommand('project', cmd)).toBe('blocked')
  })
  test('covers event and source clip editing', () => {
    for (const c of ['addEvent', 'editClips']) {
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
  // Undoing a clip deletion in the project timeline modifies only the project, not the source document.
  // View in the export-complete toast only opens the export drawer (read-only; does not modify the source document).
    expect(unguarded.every((r) => /^undo\b/.test(r) || r.startsWith('() => setExportOpen(true)'))).toBe(true)
  })
})
