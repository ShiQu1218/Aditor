import { describe, expect, test } from 'vitest'
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
