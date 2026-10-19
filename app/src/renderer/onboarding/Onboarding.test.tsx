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

describe('Onboarding step content', () => {
  test('Dialog accessibility attributes and progress indicator', () => {
    const out = html(0)
    expect(out).toContain('role="dialog"')
    expect(out).toContain('aria-modal="true"')
    expect(out).toContain('aria-labelledby="ob-title"')
    expect(out).toContain('第 1 步，共 4 步')
    expect(html(2)).toContain('第 3 步，共 4 步')
  })

  test('Step 1: welcome text and language selector (system default and all languages)', () => {
    const out = html(0)
    expect(out).toContain(t.welcome.title)
    expect(out).toContain(t.welcome.body)
    expect(out).toContain(t.welcome.languageAuto)
    for (const name of ['繁體中文', 'English', '日本語', '한국어', '简体中文']) expect(out).toContain(name)
    expect(out).toContain(t.skip)
    expect(out).not.toContain(t.back)
    expect(out).toContain(t.next)
  })

  test('Step 2: suggested root folder and preview of its three subfolders', () => {
    const out = html(1)
    expect(out).toContain(t.storage.title)
    expect(out).toContain(SUGGESTED)
    expect(out).toContain(t.storage.choose)
    expect(out).toContain(joinForDisplay(SUGGESTED, 'Recordings', '日期'))
    expect(out).toContain(joinForDisplay(SUGGESTED, 'Exports', 'Merged'))
    expect(out).toContain(joinForDisplay(SUGGESTED, 'Exports', 'Clips'))
    expect(out).toContain(t.back)
  })

  test('Step 3: recording mode radio cards (session selected by default) and default resolution, frame rate, and bitrate', () => {
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

  test('Step 4: settings summary and next steps, with a “Get started” button', () => {
    const out = html(3, { mode: 'match', height: 1440, fps: 120, bitrateKbps: 30000 })
    expect(out).toContain(`儲存位置：${SUGGESTED}`)
    expect(out).toContain('錄影模式：一局一個檔')
    expect(out).toContain('畫質：1440p (2K)、120 fps、30000 kbps')
    expect(out).toContain(t.done.next1)
    expect(out).toContain(t.done.next2)
    expect(out).toContain(t.finish)
    expect(out).not.toContain(`>${t.next}<`)
  })

  test('Every step has a “Not now” option', () => {
    for (const step of [0, 1, 2, 3]) expect(html(step)).toContain(t.skip)
  })
})

describe('Onboarding interactions and submitted data', () => {
  test('Navigates forward and backward, then writes all settings once on completion', async () => {
    const { api, set } = makeApi()
    const onClose = vi.fn()
    mount(<Onboarding api={api} language="auto" onClose={onClose} />)
    await flush()
    click(buttonByText(document.body, t.next)!)
    await flush()
    expect(document.body.textContent).toContain(t.storage.title)
    expect(document.body.textContent).toContain(SUGGESTED) // The suggested value comes from IPC.
    click(buttonByText(document.body, t.back)!)
    await flush()
    expect(document.body.textContent).toContain(t.welcome.title)
    click(buttonByText(document.body, t.next)!)
    await flush()
    click(buttonByText(document.body, t.next)!)
    await flush()
    // Step 3: switch to "One file per match".
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

  test('Selecting a folder changes the storage location and updates the preview without writing before completion', async () => {
    const { api, set } = makeApi({ picked: 'E:/Mine' })
    mount(<Onboarding api={api} language="auto" initialStep={1} />)
    await flush()
    click(buttonByText(document.body, t.storage.choose)!)
    await flush()
    expect(document.body.textContent).toContain(joinForDisplay('E:/Mine', 'Exports', 'Clips'))
    expect(set).not.toHaveBeenCalled()
  })

  test('Not now writes only onboardingDone and closes the dialog', async () => {
    const { api, set } = makeApi()
    const onClose = vi.fn()
    mount(<Onboarding api={api} language="auto" initialStep={2} onClose={onClose} />)
    await flush()
    click(buttonByText(document.body, t.skip)!)
    await flush()
    expect(set).toHaveBeenCalledWith({ onboardingDone: true })
    expect(onClose).toHaveBeenCalled()
  })

  test('Esc is equivalent to Not now', async () => {
    const { api, set } = makeApi()
    mount(<Onboarding api={api} language="auto" />)
    await flush()
    press(document.querySelector('[role="dialog"]')!, 'Escape')
    await flush()
    expect(set).toHaveBeenCalledWith({ onboardingDone: true })
  })

  test('Storage location failure returns to that step, shows an error, and keeps onboarding open', async () => {
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

  test('Language selector immediately writes settings.language', async () => {
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

describe('OnboardingHost visibility conditions', () => {
  test('Hidden when onboardingDone is true or settings have not loaded', () => {
    const { api } = makeApi()
    expect(renderToString(<OnboardingHost settings={null} api={api} />)).toBe('')
    expect(renderToString(<OnboardingHost settings={{ ...DEFAULT_SETTINGS, onboardingDone: true }} api={api} />)).toBe('')
  })
  test('Shows the dialog when onboardingDone is false', () => {
    const { api } = makeApi()
    const out = renderToString(<OnboardingHost settings={{ ...DEFAULT_SETTINGS, onboardingDone: false }} api={api} />)
    expect(out).toContain('role="dialog"')
    expect(out).toContain(t.welcome.title)
  })
  test('AppShell uses the onboardingDone setting to decide whether to show onboarding', () => {
    const src = fs.readFileSync(path.join(__dirname, '../shell/AppShell.tsx'), 'utf-8')
    expect(src).toContain('OnboardingHost')
    expect(src).toContain('onboardingDone')
  })
})
