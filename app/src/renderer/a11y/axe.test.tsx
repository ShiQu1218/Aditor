// @vitest-environment jsdom
// axe-core（jsdom）：影片庫、工作室、設定、匯出抽屜（四種狀態＋同意對話框）、快捷鍵說明各掃一次，不得有 serious／critical 違規。
import React from 'react'
import fs from 'fs'
import path from 'path'
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { LibraryScreen } from '../library/LibraryScreen'
import { SettingsScreen } from '../settings/SettingsScreen'
import { ExportDrawer } from '../studio/ExportDrawer'
import { createExportController, type ExportApi } from '../studio/exportController'
import { createProject } from '../editor/project'
import { makeLibraryFixture } from '../dev/libraryFixture'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { mountStudio } from '../../../test/studioHarness'
import { DISABLED_RULES, formatFindings, runAxe } from '../../../test/axe'
import { buttonByText, cleanupMounted, click, flush, installDomShims, mount, press } from '../../../test/dom'

beforeAll(() => {
  // 與 index.html 一致的文件層級屬性（lang、title）：由檔案讀取，避免測試與實際頁面各說各話
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf-8')
  const lang = /<html[^>]*\blang="([^"]+)"/.exec(html)?.[1]
  const title = /<title>([^<]+)<\/title>/.exec(html)?.[1]
  expect(lang, 'index.html <html lang>').toBeTruthy()
  expect(title, 'index.html <title>').toBeTruthy()
  document.documentElement.lang = lang!
  document.title = title!
})
beforeEach(() => installDomShims())
afterEach(() => cleanupMounted())

async function expectNoSeriousViolations(label: string): Promise<void> {
  const findings = await runAxe(document)
  expect(findings, `${label}\n${formatFindings(findings)}`).toEqual([])
}

describe('axe-core (jsdom) — no serious/critical violations', () => {
  test('the disabled-rule list is explicit and every entry has a reason', () => {
    for (const [id, why] of Object.entries(DISABLED_RULES)) expect(why.length, id).toBeGreaterThan(10)
  })

  test('canary: the harness really detects violations (unnamed button, image without alt, unlabeled input)', async () => {
    const holder = document.createElement('div')
    holder.innerHTML = '<button></button><img src="x.png"><input type="text">'
    document.body.appendChild(holder)
    const ids = (await runAxe(document)).map((f) => f.id)
    holder.remove()
    expect(ids).toEqual(expect.arrayContaining(['button-name', 'image-alt', 'label']))
  })

  test('Library (done, analyzing, pending/not analyzed and error cards; favorites; queue strip)', async () => {
    const now = Date.now()
    const entries = makeLibraryFixture(30, now).map((e, i) => ({ ...e, addedAt: now - i * 1000 }))
    expect(new Set(entries.map((e) => e.status))).toEqual(new Set(['done', 'pending', 'analyzing', 'error']))
    const restore = installFakeApi(createFakeApi({ entries }))
    try {
      mount(
        <Providers>
          <LibraryScreen onSelectVideo={() => undefined} onOpenSettings={() => undefined} />
        </Providers>
      )
      await flush()
      expect(document.querySelectorAll('.vcard.err').length).toBeGreaterThan(0)
      expect(document.querySelectorAll('.vcard.busy').length).toBeGreaterThan(0)
      await expectNoSeriousViolations('library')
      // 卡片 ⋯ 選單與空狀態也掃
      click(document.querySelector('.vcard-more')!)
      await expectNoSeriousViolations('library with card menu open')
    } finally {
      restore()
    }
  })

  test('Library: empty state', async () => {
    const restore = installFakeApi(createFakeApi({ entries: [] }))
    try {
      mount(
        <Providers>
          <LibraryScreen onSelectVideo={() => undefined} onOpenSettings={() => undefined} />
        </Providers>
      )
      await flush()
      await expectNoSeriousViolations('library empty')
    } finally {
      restore()
    }
  })

  test('Studio: highlights tab, events tab and project track with items', async () => {
    const s = await mountStudio({
      items: [
        { id: 'i1', source: 'fixture://long', start: 10, end: 20 },
        { id: 'i2', source: 'D:/other.mp4', start: 5, end: 25 }
      ]
    })
    try {
      expect(document.querySelectorAll('.hl-card').length).toBeGreaterThan(0)
      await expectNoSeriousViolations('studio / highlights tab')
      const evTab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => t.textContent?.includes('事件'))!
      click(evTab)
      await flush()
      expect(document.querySelectorAll('.ev-row').length).toBeGreaterThan(0)
      await expectNoSeriousViolations('studio / events tab')
      // 對話框狀態：新增事件、AI 浮層
      press(document.body, 'm')
      expect(document.querySelector('.add-event')).not.toBeNull()
      await expectNoSeriousViolations('studio / add-event dialog')
      press(document.activeElement ?? document.body, 'Escape')
      click(document.querySelector('[data-autoclip="toggle"]')!)
      await flush()
      expect(document.querySelector('.autoclip-pop')).not.toBeNull()
      await expectNoSeriousViolations('studio / AI popover')
      press(document.activeElement ?? document.body, 'Escape')
      // 快捷鍵說明
      press(document.body, '?', { shiftKey: true })
      expect(document.querySelector('.sc-dialog')).not.toBeNull()
      await expectNoSeriousViolations('studio / shortcuts dialog')
    } finally {
      s.restore()
    }
  })

  test('Studio: new-project dialog', async () => {
    const s = await mountStudio({ items: [{ id: 'i1', source: 'fixture://long', start: 10, end: 20 }] })
    try {
      click(buttonByText(document.body, '新專案')!)
      expect(document.querySelector('.np-dlg')).not.toBeNull()
      await expectNoSeriousViolations('studio / new-project dialog')
    } finally {
      s.restore()
    }
  })

  test.each([['a'], ['b'], ['c']] as const)('Settings category %s', async (cat) => {
    const restore = installFakeApi(createFakeApi())
    try {
      mount(
        <Providers active="settings">
          <SettingsScreen initialCategory={cat} />
        </Providers>
      )
      await flush(30)
      expect(document.querySelectorAll('.set-card').length).toBeGreaterThan(0)
      await expectNoSeriousViolations(`settings ${cat}`)
    } finally {
      restore()
    }
  })

  describe('ExportDrawer — all four states + OpenH264 consent', () => {
    function api(over: Partial<ExportApi> = {}): ExportApi {
      return {
        detectEncoders: async () => ['h264_nvenc'],
        openh264Status: async () => ({ installed: true }),
        downloadOpenH264: async () => 'x',
        selectOutDir: async () => 'D:/o',
        checkOutDir: async () => ({ ok: true }),
        openFolder: async () => true,
        start: () => new Promise(() => undefined),
        cancel: async () => ({ cancelled: true }),
        diskSpace: async () => ({ freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 }),
        onProgress: () => () => undefined,
        onOpenH264Progress: () => () => undefined,
        ...over
      } as ExportApi
    }
    const project = { ...createProject('合輯'), items: [{ id: 'a', source: 'D:/v.mp4', start: 1, end: 9 }] }
    const base = { sources: { 'D:/v.mp4': { codec: 'h264', width: 1920, height: 1080 } }, keyframes: {}, missingItemIds: new Set<string>() }
    const items = project.items.map((i) => ({ ...i }))

    async function drawer(over: Partial<ExportApi> = {}) {
      const ctl = createExportController(api(over), '合輯')
      await ctl.init('D:/out')
      mount(<ExportDrawer controller={ctl} project={project} base={base} onClose={() => undefined} />)
      await flush()
      return ctl
    }

    test('settings', async () => {
      await drawer()
      expect(document.querySelector('.xd')!.getAttribute('data-phase')).toBe('settings')
      await expectNoSeriousViolations('export / settings')
    })
    test('settings with a blocker (bad output folder)', async () => {
      await drawer({ checkOutDir: async () => ({ ok: false, reason: '輸出資料夾無法寫入' }) })
      expect(document.querySelector('.xd-blockers')?.textContent).toContain('無法寫入')
      await expectNoSeriousViolations('export / settings blocker')
    })
    test('running', async () => {
      const ctl = await drawer()
      await act(async () => {
        void ctl.start(items)
      })
      await flush()
      expect(document.querySelector('.xd')!.getAttribute('data-phase')).toBe('running')
      await expectNoSeriousViolations('export / running')
    })
    test('done', async () => {
      const ctl = await drawer({ start: async () => ({ ok: true, outputs: ['D:/out/合輯.mp4'] }) })
      await act(async () => {
        await ctl.start(items)
      })
      expect(document.querySelector('.xd')!.getAttribute('data-phase')).toBe('done')
      await expectNoSeriousViolations('export / done')
    })
    test('failed', async () => {
      const ctl = await drawer({ start: async () => ({ ok: false, error: 'ffmpeg exited with code 1', outputs: [] }) })
      await act(async () => {
        await ctl.start(items)
      })
      expect(document.querySelector('.xd')!.getAttribute('data-phase')).toBe('failed')
      await expectNoSeriousViolations('export / failed')
    })
    test('OpenH264 consent dialog', async () => {
      const ctl = await drawer({ detectEncoders: async () => [], openh264Status: async () => ({ installed: false }) })
      await act(async () => {
        await ctl.setQuality('precise')
      })
      expect(document.querySelector('.xd-consent')).not.toBeNull()
      await expectNoSeriousViolations('export / consent')
    })
  })
})
