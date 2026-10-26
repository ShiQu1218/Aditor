import { describe, expect, it } from 'vitest'
import { fillTemplate } from './template'

describe('fillTemplate', () => {
  it('fills repeated placeholders and preserves unknown ones', () => {
    expect(fillTemplate('{name}: {n}, {name} {unknown}', { name: 'clip', n: 3 }))
      .toBe('clip: 3, clip {unknown}')
  })

  it('keeps replacement characters and placeholder-like values literal', () => {
    expect(fillTemplate('{path} {name}', { path: 'C:/$&/{name}.mp4', name: 'clip' }))
      .toBe('C:/$&/{name}.mp4 clip')
  })
})
