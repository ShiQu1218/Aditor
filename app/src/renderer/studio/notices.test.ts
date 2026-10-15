import { describe, expect, test } from 'vitest'
import { proxyBusyNotice, studioNotice } from './notices'

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

describe('proxyBusyNotice', () => {
  test('shows the percentage when progress is known, generic text otherwise', () => {
    expect(proxyBusyNotice(0.42).title).toBe('產生中… 42%')
    expect(proxyBusyNotice(null).title).toBe('正在產生代理檔…')
    expect(proxyBusyNotice(1.7).title).toBe('產生中… 100%')
  })
})

describe('error code vs message', () => {
  test('notice text carries the code only; unknown when missing', () => {
    const n = studioNotice({ analysis: 'error', playability: okPlayability, proxyState: 'none', errorCode: 3 })
    expect(n!.text).toContain('代碼 3')
    const m = studioNotice({ analysis: 'error', playability: okPlayability, proxyState: 'none' })
    expect(m!.text).toContain('unknown')
  })
})
