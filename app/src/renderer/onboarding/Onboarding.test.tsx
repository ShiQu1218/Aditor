// @vitest-environment jsdom
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { shellI18n } from '../i18n'
import { joinForDisplay } from '../../shared/storage'
import { Onboarding, OnboardingHost } from './Onboarding'
import type { OnboardingApi } from './onboardingModel'
import { buttonByText, cleanupMounted, click, flush, installDomShims, mount, press } from '../../../test/dom'

const t = shellI18n.onboarding
const SUGGESTED = 'D:/Videos/Aditor'

function makeApi(over: { set?: (p: unknown) => Promise<unknown>; picked?: string | null } = {}) {
  const set = vi.fn(over.set ?? (async () => ({ settings: DEFAULT_SETTINGS, persisted: true })))
  const api: OnboardingApi = {
    settings: { set, suggestStorageRoot: async () => SUGGESTED },
    export: { selectOutDir: async () => (over.picked === undefined ? 'E:/Mine' : over.picked) }
  }
  return { api, set }
}

const html = (step: number, draft = {}): string =>
  renderToString(
    <Onboarding api={makeApi().api} language="auto" initialStep={step} initialDraft={{ storageRoot: SUGGESTED, ...draft }} onClose={() => undefined} />
  )

beforeEach(() => installDomShims())
afterEach(() => {
  cleanupMounted()
  vi.restoreAllMocks()
})

describe('Onboarding 各步驟的內容', () => {
  test('對話框無障礙屬性與進度提示', () => {
    const out = html(0)
    expect(out).toContain('role="dialog"')
    expect(out).toContain('aria-modal="true"')
    expect(out).toContain('aria-labelledby="ob-title"')
    expect(out).toContain('第 1 步，共 4 步')
    expect(html(2)).toContain('第 3 步，共 4 步')
  })

  test('第 1 步：歡迎文字與語言下拉（跟隨系統＋各語言）', () => {
    const out = html(0)
    expect(out).toContain(t.welcome.title)
    expect(out).toContain(t.welcome.body)
    expect(out).toContain(t.welcome.languageAuto)
    for (const name of ['繁體中文', 'English', '日本語', '한국어', '简体中文']) expect(out).toContain(name)
    expect(out).toContain(t.skip)
    expect(out).not.toContain(t.back)
    expect(out).toContain(t.next)
  })

  test('第 2 步：建議根資料夾與三個子資料夾預覽', () => {
    const out = html(1)
    expect(out).toContain(t.storage.title)
    expect(out).toContain(SUGGESTED)
    expect(out).toContain(t.storage.choose)
    expect(out).toContain(joinForDisplay(SUGGESTED, 'Recordings', '日期'))
    expect(out).toContain(joinForDisplay(SUGGESTED, 'Exports', 'Merged'))
    expect(out).toContain(joinForDisplay(SUGGESTED, 'Exports', 'Clips'))
    expect(out).toContain(t.back)
  })

  test('第 3 步：錄影模式單選卡片（預設選中 session）、解析度／影格率／位元率預設值', () => {
    const out = html(2)
    expect(out).toContain('一局一個檔')
    expect(out).toContain('從頭錄到尾')
    expect(out).toContain(t.recording.modeMatchDesc)
    expect(out).toContain(t.recording.modeSessionDesc)
    expect(out).toMatch(/<input[^>]*type="radio"[^>]*checked=""[^>]*value="session"/)
    expect(out).not.toMatch(/<input[^>]*type="radio"[^>]*checked=""[^>]*value="match"/)
    expect(out).toMatch(/<option value="1080" selected/)
    expect(out).toMatch(/<option value="60" selected/)
    expect(out).toMatch(/<option value="10000" selected/)
    for (const label of ['720p (HD)', '1080p (Full HD)', '1440p (2K)', '原生']) expect(out).toContain(label)
  })

  test('第 4 步：設定摘要與接下來會發生的事，按鈕是「開始使用」', () => {
    const out = html(3, { mode: 'match', height: 1440, fps: 120, bitrateKbps: 30000 })
    expect(out).toContain(`儲存位置：${SUGGESTED}`)
    expect(out).toContain('錄影模式：一局一個檔')
    expect(out).toContain('畫質：1440p (2K)、120 fps、30000 kbps')
    expect(out).toContain(t.done.next1)
    expect(out).toContain(t.done.next2)
    expect(out).toContain(t.finish)
    expect(out).not.toContain(`>${t.next}<`)
  })

  test('每一步都有「稍後再說」', () => {
    for (const step of [0, 1, 2, 3]) expect(html(step)).toContain(t.skip)
  })
})

describe('Onboarding 互動與送出內容', () => {
  test('逐步前進、後退，完成時一次寫入全部設定', async () => {
    const { api, set } = makeApi()
    const onClose = vi.fn()
    mount(<Onboarding api={api} language="auto" onClose={onClose} />)
    await flush()
    click(buttonByText(document.body, t.next)!)
    await flush()
    expect(document.body.textContent).toContain(t.storage.title)
    expect(document.body.textContent).toContain(SUGGESTED) // 建議值由 IPC 取得
    click(buttonByText(document.body, t.back)!)
    await flush()
    expect(document.body.textContent).toContain(t.welcome.title)
    click(buttonByText(document.body, t.next)!)
    await flush()
    click(buttonByText(document.body, t.next)!)
    await flush()
    // 第 3 步：改成「一局一個檔」
    click(document.querySelector<HTMLInputElement>('input[type="radio"][value="match"]')!)
    await flush()
    click(buttonByText(document.body, t.next)!)
    await flush()
    click(buttonByText(document.body, t.finish)!)
    await flush()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({
      storageRoot: SUGGESTED,
      onboardingDone: true,
      recording: { mode: 'match', height: 1080, fps: 60, bitrateKbps: 10000 }
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('選擇資料夾會更換儲存位置並更新預覽（完成前不寫入）', async () => {
    const { api, set } = makeApi({ picked: 'E:/Mine' })
    mount(<Onboarding api={api} language="auto" initialStep={1} />)
    await flush()
    click(buttonByText(document.body, t.storage.choose)!)
    await flush()
    expect(document.body.textContent).toContain(joinForDisplay('E:/Mine', 'Exports', 'Clips'))
    expect(set).not.toHaveBeenCalled()
  })

  test('稍後再說：只寫 onboardingDone 並關閉', async () => {
    const { api, set } = makeApi()
    const onClose = vi.fn()
    mount(<Onboarding api={api} language="auto" initialStep={2} onClose={onClose} />)
    await flush()
    click(buttonByText(document.body, t.skip)!)
    await flush()
    expect(set).toHaveBeenCalledWith({ onboardingDone: true })
    expect(onClose).toHaveBeenCalled()
  })

  test('Esc 等同稍後再說', async () => {
    const { api, set } = makeApi()
    mount(<Onboarding api={api} language="auto" />)
    await flush()
    press(document.querySelector('[role="dialog"]')!, 'Escape')
    await flush()
    expect(set).toHaveBeenCalledWith({ onboardingDone: true })
  })

  test('儲存位置失敗：回到儲存位置步驟顯示錯誤，不關閉引導', async () => {
    const { api } = makeApi({
      set: async () => ({ settings: DEFAULT_SETTINGS, persisted: true, errors: { storageRoot: '無法建立或寫入儲存位置：Z:/nope' } })
    })
    const onClose = vi.fn()
    mount(<Onboarding api={api} language="auto" initialStep={3} onClose={onClose} />)
    await flush()
    click(buttonByText(document.body, t.finish)!)
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(t.storage.title)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('無法建立或寫入儲存位置：Z:/nope')
  })

  test('語言下拉：立刻寫入 settings.language', async () => {
    const { api, set } = makeApi()
    mount(<Onboarding api={api} language="auto" />)
    await flush()
    const select = document.getElementById('ob-language') as HTMLSelectElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'en')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(set).toHaveBeenCalledWith({ language: 'en' })
  })
})

describe('OnboardingHost 的顯示條件', () => {
  test('onboardingDone 為 true、或設定尚未載入時不顯示', () => {
    const { api } = makeApi()
    expect(renderToString(<OnboardingHost settings={null} api={api} />)).toBe('')
    expect(renderToString(<OnboardingHost settings={{ ...DEFAULT_SETTINGS, onboardingDone: true }} api={api} />)).toBe('')
  })
  test('onboardingDone 為 false 時顯示對話框', () => {
    const { api } = makeApi()
    const out = renderToString(<OnboardingHost settings={{ ...DEFAULT_SETTINGS, onboardingDone: false }} api={api} />)
    expect(out).toContain('role="dialog"')
    expect(out).toContain(t.welcome.title)
  })
  test('AppShell 以設定的 onboardingDone 決定是否顯示引導', () => {
    const src = fs.readFileSync(path.join(__dirname, '../shell/AppShell.tsx'), 'utf-8')
    expect(src).toContain('OnboardingHost')
    expect(src).toContain('onboardingDone')
  })
})
