import React from 'react'
import { renderToString } from 'react-dom/server'
import fs from 'fs'
import path from 'path'
import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS, type Settings, type SettingsSetResult } from '../../shared/settings'
import { SettingsScreen } from './SettingsScreen'
import { SettingsController, type SettingsApi } from './settingsController'
import { settingsI18n } from '../i18n/zh-TW'

function fakeApi(opts: { persisted?: boolean; settings?: Partial<Settings> } = {}): SettingsApi {
  let current: Settings = { ...DEFAULT_SETTINGS, ...opts.settings }
  return {
    settings: {
      get: async () => current,
      set: async (partial): Promise<SettingsSetResult> => {
        current = { ...current, ...partial } as Settings
        return { settings: current, persisted: opts.persisted ?? true }
      },
      onChanged: () => () => undefined
    },
    library: {
      getEntries: async () => [{ path: 'D:/a.mp4' }],
      getWatchFolders: async () => ({ dirs: ['D:\\Outplayed\\Apex Legends', 'E:\\Captures\\Apex'], missing: ['E:\\Captures\\Apex'] }),
      addWatchFolder: async () => ({ ok: true, dirs: [], missing: [] }),
      removeWatchFolder: async () => ({ ok: true, dirs: [], missing: [] })
    },
    proxy: { usage: async () => ({ count: 3, bytes: 2.4 * 1024 ** 3 }), delete: async () => true },
    export: {
      detectEncoders: async () => ['h264_nvenc'],
      selectOutDir: async () => 'D:/Videos/Apex',
      openh264Status: async () => ({ installed: true })
    }
  }
}

async function render(
  props: { initialQuery?: string; initialCategory?: 'a' | 'b' | 'c' } = {},
  api: SettingsApi = fakeApi(),
  after?: (c: SettingsController) => Promise<void>
): Promise<string> {
  const controller = new SettingsController(api)
  await controller.start()
  if (after) await after(controller)
  return renderToString(React.createElement(SettingsScreen, { controller, ...props }))
}

const rowIds = (html: string): string[] => [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])

describe('SettingsScreen markup（renderToString + fake window.api 資料）', () => {
  test('loading state before settings arrive', () => {
    const html = renderToString(
      React.createElement(SettingsScreen, { controller: new SettingsController(fakeApi()) })
    )
    expect(html).toContain(settingsI18n.loading)
  })

  test('category a: watch folders, auto analyze, decode, cache, low-perf (5 rows) with the exact tablist', async () => {
    const html = await render({ initialCategory: 'a' })
    expect(rowIds(html)).toEqual(['watchFolders', 'autoAnalyze', 'decode', 'cacheLocation', 'lowPerfMode'])
    expect(html).toContain('影片來源')
    expect(html).toContain('分析與效能')
    // 監看資料夾來自 getWatchFolders，缺失者有標記，每個都有可命名的移除按鈕
    expect(html).toContain('D:\\Outplayed\\Apex Legends')
    expect(html).toContain('找不到此資料夾')
    expect(html).toContain('aria-label="移除監看資料夾 D:\\Outplayed\\Apex Legends"')
    expect(html).toContain('新增資料夾')
  })

  test('category b: proxy + clip defaults (6 rows) with usage text and steppers', async () => {
    const html = await render({ initialCategory: 'b' })
    expect(rowIds(html)).toEqual(['proxySuggest', 'proxyUsage', 'beforeAfter', 'autoclip', 'autoSuggestOnOpen', 'projectAutosave'])
    expect(html).toContain('2.4 GB（3 個檔案）')
    expect(html).toContain('刪除全部代理檔')
    // 數字框：min／max 來自 shared 範圍
    expect(html).toMatch(/id="set-beforeAfter-before"[^>]*min="0"[^>]*max="30"/)
    expect(html).toMatch(/id="set-autoclip-max_len"[^>]*min="15"[^>]*max="300"/)
    expect(html).toMatch(/id="set-autoclip-gap"[^>]*min="5"[^>]*max="60"/)
    expect(html).toMatch(/id="set-autoclip-n"[^>]*min="1"[^>]*max="10"/)
    expect(html).toContain('aria-label="減少事件前秒數"')
  })

  test('category c: export + about (5 rows), encoders and OpenH264 state, trademark text', async () => {
    const html = await render({ initialCategory: 'c' })
    expect(rowIds(html)).toEqual(['defaultOutDir', 'encoders', 'openh264', 'about', 'trademark'])
    expect(html).toContain('NVENC ✓')
    expect(html).toContain('QSV ✗')
    expect(html).toContain('已安裝')
    expect(html).toContain('Apex Legends 為 Electronic Arts／Respawn 之商標')
    expect(html).toContain('每次詢問')
  })

  test('controls are real labelled form controls (label for, aria-describedby, role=switch checkbox)', async () => {
    const html = await render({ initialCategory: 'a' })
    expect(html).toMatch(/<label[^>]*for="set-autoAnalyze"[^>]*>新影片自動分析<\/label>/)
    expect(html).toMatch(/<input[^>]*id="set-autoAnalyze"[^>]*type="checkbox"[^>]*role="switch"/)
    expect(html).toMatch(/id="set-autoAnalyze"[^>]*aria-describedby="set-autoAnalyze-desc"/)
    expect(html).toMatch(/<label[^>]*for="set-decode"/)
    expect(html).toMatch(/<select[^>]*id="set-decode"/)
    expect(html).not.toMatch(/role="switch"[^>]*aria-checked/) // 原生 checked，不重複宣告
  })

  test('switch and select reflect the settings (checked / selected)', async () => {
    const html = await render(
      { initialCategory: 'a' },
      fakeApi({ settings: { autoAnalyze: false, lowPerfMode: true, decode: 'software' } })
    )
    expect(html).toMatch(/id="set-autoAnalyze"(?![^>]*checked)/)
    expect(html).toMatch(/id="set-lowPerfMode"[^>]*checked/)
    expect(html).toMatch(/<option value="software" selected/)
  })

  test('tablist: role, label, three tabs, roving tabindex and aria-selected on the active one', async () => {
    const html = await render({ initialCategory: 'b' })
    expect(html).toMatch(/role="tablist"[^>]*aria-label="設定分類"[^>]*aria-orientation="vertical"|aria-orientation="vertical"[^>]*role="tablist"/)
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0])
    expect(tabs).toHaveLength(3)
    expect(tabs[0]).toContain('aria-selected="false"')
    expect(tabs[0]).toContain('tabindex="-1"')
    expect(tabs[1]).toContain('aria-selected="true"')
    expect(tabs[1]).toContain('tabindex="0"')
    expect(tabs[1]).toContain('class="set-cat active"') // 紅色指示條由 .active::before 繪製
    expect(tabs[2]).toContain('tabindex="-1"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('aria-labelledby="set-tab-b"')
    for (const label of ['影片與分析', '預覽與剪輯', '匯出與關於']) expect(html).toContain(label)
  })

  test('only the active category rows are rendered without a search', async () => {
    const html = await render({ initialCategory: 'a' })
    expect(html).not.toContain('data-row="proxySuggest"')
    expect(html).not.toContain('data-row="encoders"')
  })

  test('search results: rows from ALL categories, grouped by card, with per-category hit counts', async () => {
    const html = await render({ initialQuery: '資料夾' })
    // 監看資料夾（a）與預設輸出資料夾（c）；b 沒有命中
    expect(rowIds(html)).toEqual(['watchFolders', 'defaultOutDir'])
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="搜尋結果"')
    expect(html).not.toContain('role="tabpanel"')
    // 只顯示命中的列（同卡片的其他列被濾掉）
    expect(html).not.toContain('data-row="autoAnalyze"')
    expect(html).toContain('影片來源') // 卡片標題保留
    // 各分類命中數（a、c 有；b 沒有）
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>.*?<\/button>/g)].map((m) => m[0])
    expect(tabs[0]).toContain('class="set-hit"')
    expect(tabs[1]).not.toContain('set-hit')
    expect(tabs[2]).toContain('class="set-hit"')
    expect(tabs[0]).toMatch(/aria-label="1 項符合">1</)
  })

  test('search matches keywords case-insensitively (NVENC → encoders row)', async () => {
    const html = await render({ initialQuery: 'nvenc' })
    expect(rowIds(html)).toEqual(['encoders'])
  })

  test('search with no match shows 沒有符合的設定 and no rows', async () => {
    const html = await render({ initialQuery: 'zzzz-not-a-setting' })
    expect(html).toContain('沒有符合的設定')
    expect(rowIds(html)).toEqual([])
    expect(html).not.toContain('class="set-hit"')
  })

  test('rows whose backend does not exist are disabled with grey explanatory text', async () => {
    const html = await render({ initialCategory: 'c' })
    // 第三方授權（I11）：已可使用，不再是停用列
    expect(html).not.toMatch(/<button[^>]*id="set-about"[^>]*disabled/)
    expect(html).not.toContain('授權清單頁面將在後續更新提供。')
    expect(html).toMatch(/class="set-desc set-grey"/)
    // OpenH264 重新下載：停用並說明原因
    expect(html).toMatch(/<button[^>]*id="set-openh264"[^>]*disabled/)
    expect(html).toContain('下載需在匯出面板同意授權後進行。')
    expect(html).toContain('data-disabled="true"')
  })

  test('the developer note 需新增 IPC never appears in any category or search markup', async () => {
    for (const cat of ['a', 'b', 'c'] as const) {
      expect(await render({ initialCategory: cat })).not.toContain('需新增 IPC')
    }
    expect(await render({ initialQuery: '設定' })).not.toContain('需新增 IPC')
  })

  test('new settings carry the 新 tag (low-perf, auto suggest, autosave)', async () => {
    const b = await render({ initialCategory: 'b' })
    expect((b.match(/class="set-newtag"/g) ?? []).length).toBe(2)
  })
})

describe('save-failed notice and state sync', () => {
  test('persisted:false → 儲存失敗 notice in an aria-live region; control shows the RETURNED value', async () => {
    const html = await render({ initialCategory: 'a' }, fakeApi({ persisted: false }), async (c) => {
      await c.setBool('lowPerfMode', true)
    })
    expect(html).toContain('儲存失敗')
    expect(html).toMatch(/class="set-notice-host"[^>]*role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*class="set-notice-host"|role="status"[^>]*class="set-notice-host"/)
    expect(html).toMatch(/id="set-lowPerfMode"[^>]*checked/)
  })

  test('persisted:true → no notice', async () => {
    const html = await render({ initialCategory: 'a' }, fakeApi(), async (c) => {
      await c.setBool('lowPerfMode', true)
    })
    expect(html).not.toContain('儲存失敗')
    // live region 容器仍存在（內容為空），之後插入的訊息才會被朗讀
    expect(html).toContain('set-notice-host')
  })

  test('a backend that rejects the change leaves the control at the returned (old) value', async () => {
    const api = fakeApi()
    api.settings.set = async () => ({ settings: { ...DEFAULT_SETTINGS, lowPerfMode: false }, persisted: true })
    const html = await render({ initialCategory: 'a' }, api, async (c) => {
      await c.setBool('lowPerfMode', true)
    })
    expect(html).toMatch(/id="set-lowPerfMode"(?![^>]*checked)/)
  })

  test('numeric inputs show the clamped value returned by main, never the typed 99', async () => {
    const html = await render({ initialCategory: 'b' }, fakeApi(), async (c) => {
      await c.setNumber('before', 99)
      await c.setAutoclip('max_len', 9999)
    })
    expect(html).toMatch(/id="set-beforeAfter-before"[^>]*value="30"/)
    expect(html).toMatch(/id="set-autoclip-max_len"[^>]*value="300"/)
  })

  test('path validation errors from main are shown in the row (role=alert)', async () => {
    const api = fakeApi()
    api.settings.set = async () => ({
      settings: { ...DEFAULT_SETTINGS },
      persisted: true,
      errors: { defaultOutDir: '資料夾不存在：Z:\\nope' }
    })
    const html = await render({ initialCategory: 'c' }, api, async (c) => {
      await c.pickOutDir()
    })
    expect(html).toMatch(/<p[^>]*class="set-err"[^>]*role="alert"[^>]*>資料夾不存在：Z:\\nope<\/p>/)
    expect(html).toMatch(/id="set-defaultOutDir"[^>]*aria-describedby="[^"]*set-defaultOutDir-err/)
  })

  test('load failure shows defaults plus a notice', async () => {
    const api = fakeApi()
    api.settings.get = async () => {
      throw new Error('x')
    }
    const html = await render({ initialCategory: 'a' }, api)
    expect(html).toContain('無法讀取設定')
    expect(html).toContain('data-row="autoAnalyze"')
  })
})

describe('wiring: preload channel names match the main-process handlers', () => {
  const read = (p: string): string => fs.readFileSync(path.join(__dirname, '../../', p), 'utf-8')
  const preload = read('preload/index.ts')
  const mainSources = [read('main/ipc-handlers.ts'), read('main/settings-ipc.ts')].join('\n')

  test.each([
    ['settings:get'],
    ['settings:set'],
    ['proxy:usage'],
    ['proxy:delete'],
    ['library:getWatchFolders'],
    ['library:addWatchFolder'],
    ['library:removeWatchFolder'],
    ['library:getEntries'],
    ['export:detectEncoders'],
    ['export:selectOutDir'],
    ['export:openh264Status']
  ])('invoke channel %s is handled in main', (channel) => {
    expect(preload).toContain(`ipcRenderer.invoke('${channel}'`)
    expect(mainSources).toContain(`'${channel}'`)
  })

  test('settings:changed is sent by main and listened to by preload', () => {
    expect(mainSources).toContain(`'settings:changed'`)
    expect(preload).toContain(`ipcRenderer.on('settings:changed'`)
  })

  test('controller api shape is what preload exposes (names used by SettingsController exist)', () => {
    for (const name of ['getEntries', 'getWatchFolders', 'addWatchFolder', 'removeWatchFolder', 'usage', 'detectEncoders', 'selectOutDir', 'openh264Status', 'onChanged']) {
      expect(preload).toContain(`${name}:`)
    }
  })
})

describe('static rules for the settings sources', () => {
  const dir = __dirname
  const tsx = fs.readdirSync(dir).filter((f) => f.endsWith('.tsx'))
  test('no hex colour literals in TSX', () => {
    for (const f of tsx) {
      expect(fs.readFileSync(path.join(dir, f), 'utf-8'), f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
  })
  test('no alert() / backdrop-filter', () => {
    for (const f of tsx) expect(fs.readFileSync(path.join(dir, f), 'utf-8'), f).not.toMatch(/\balert\(/)
    const css = fs.readFileSync(path.join(dir, '../styles/settings.css'), 'utf-8')
    expect(css).not.toContain('backdrop-filter')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
