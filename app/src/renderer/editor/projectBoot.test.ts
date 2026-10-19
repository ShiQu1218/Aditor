import { describe, expect, test } from 'vitest'
import { ProjectBoot } from './projectBoot'

describe('ProjectBoot', () => {
  test('idle → restoring → ready', () => {
    const b = new ProjectBoot()
    expect(b.phase).toBe('idle')
    b.start()
    expect(b.phase).toBe('restoring')
    b.restored(true)
    expect(b.phase).toBe('ready')
  })

  test('restore with no prior edit is applied once', () => {
    const b = new ProjectBoot()
    b.start()
    b.settingsLoaded(true)
    expect(b.restored(true)).toBe(true)
    expect(b.restored(true)).toBe(false) // A second call (which should not happen) does not apply it again.
  })

  test('edit before the restore resolves: keep user project, skip restore', () => {
    const b = new ProjectBoot()
    b.start()
    b.edit()
    expect(b.restored(true)).toBe(false)
    expect(b.phase).toBe('ready')
  })

  test('nothing to restore → nothing applied', () => {
    const b = new ProjectBoot()
    b.start()
    expect(b.restored(false)).toBe(false)
  })

  test('edit after restore does not matter', () => {
    const b = new ProjectBoot()
    b.start()
    expect(b.restored(true)).toBe(true)
    b.edit()
    expect(b.edited).toBe(true)
  })

  test('restore resolving before settings (any ordering) is still applied when unedited', () => {
    const b = new ProjectBoot()
    b.start()
    expect(b.restored(true)).toBe(true)
    expect(b.settingsKnown).toBe(false)
    b.settingsLoaded(false)
    expect(b.settingsKnown).toBe(true)
    expect(b.autosaveEnabled).toBe(false)
  })

  test('edit, then settings, then restore', () => {
    const b = new ProjectBoot()
    b.start()
    b.edit()
    expect(b.settingsLoaded(true)).toBe(true)
    expect(b.restored(true)).toBe(false)
  })

  test('settings failing or malformed defaults autosave to enabled', () => {
    for (const raw of [null, undefined, 'yes', 1]) {
      const b = new ProjectBoot()
      expect(b.settingsLoaded(raw)).toBe(true)
    }
    expect(new ProjectBoot().settingsLoaded(false)).toBe(false)
  })

  test('restored without start (restore never began) never applies', () => {
    const b = new ProjectBoot()
    expect(b.restored(true)).toBe(false)
  })
})
