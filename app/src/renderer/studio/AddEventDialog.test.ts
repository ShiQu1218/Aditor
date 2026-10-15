import { describe, expect, test } from 'vitest'
import { enterConfirms } from './AddEventDialog'

describe('enterConfirms', () => {
  test('Enter on the cancel/confirm buttons is left to the button itself (never confirms from the window handler)', () => {
    expect(enterConfirms({ tagName: 'BUTTON' })).toBe(false)
  })
  test('Enter on the dialog box or a radio confirms', () => {
    expect(enterConfirms({ tagName: 'DIV' })).toBe(true)
    expect(enterConfirms({ tagName: 'INPUT' })).toBe(true)
    expect(enterConfirms(null)).toBe(true)
  })
})
