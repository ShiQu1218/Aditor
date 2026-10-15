import { describe, expect, test } from 'vitest'
import { studioNotice } from './notices'

const okPlayability = { supported: true, smooth: true, powerEfficient: true }
const weakPlayability = { supported: false, smooth: false, powerEfficient: false }

describe('studioNotice', () => {
  test('error → engine-crash notice with resume action', () => {
    const n = studioNotice({ analysis: 'error', playability: okPlayability, proxyState: 'none' })
    expect(n).not.toBeNull()
    expect(n!.kind).toBe('error')
    expect(n!.title).toContain('分析引擎異常結束')
    expect(n!.actions).toContain('resume')
  })

  test('non-playable/no hw decode → proxy suggestion; playable → null', () => {
    const n = studioNotice({ analysis: 'done', playability: weakPlayability, proxyState: 'none' })
    expect(n).not.toBeNull()
    expect(n!.kind).toBe('warn')
    expect(n!.actions).toContain('generateProxy')
    expect(n!.actions).toContain('later')

    expect(studioNotice({ analysis: 'done', playability: okPlayability, proxyState: 'none' })).toBeNull()
  })

  test('no proxy suggestion when a proxy already exists or is generating', () => {
    expect(studioNotice({ analysis: 'done', playability: weakPlayability, proxyState: 'available' })).toBeNull()
    expect(studioNotice({ analysis: 'done', playability: weakPlayability, proxyState: 'generating' })).toBeNull()
  })

  test('error outranks proxy suggestion', () => {
    const n = studioNotice({ analysis: 'error', playability: weakPlayability, proxyState: 'none' })
    expect(n!.kind).toBe('error')
  })
})
