import React from 'react'
import { renderToString } from 'react-dom/server'
import fs from 'fs'
import path from 'path'
import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings, type SettingsSetResult } from '../../shared/settings'
import type { UpdateStatus } from '../../shared/update'
import { SettingsScreen } from './SettingsScreen'
import { SettingsController, type SettingsApi } from './settingsController'
import { settingsI18n } from '../i18n'
import { SETTING_ROWS, type CategoryId } from './rows'

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
      openFolder: async () => true,
      openh264Status: async () => ({ installed: true })
    }
  }
}

async function render(
  props: { initialQuery?: string; initialCategory?: CategoryId } = {},
  api: SettingsApi = fakeApi(),
  after?: (c: SettingsController) => Promise<void>
): Promise<string> {
  const controller = new SettingsController(api)
  await controller.start()
  if (after) await after(controller)
  return renderToString(React.createElement(SettingsScreen, { controller, ...props }))
}

const rowIds = (html: string): string[] => [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])

describe('SettingsScreen markup (renderToString + fake window.api data)', () => {
  test('loading state before settings arrive', () => {
    const html = renderToString(
      React.createElement(SettingsScreen, { controller: new SettingsController(fakeApi()) })
    )
    expect(html).toContain(settingsI18n.loading)
  })

  test('category general: language, low-perf, startup/tray, storage root (5 rows) in three cards', async () => {
    const html = await render({ initialCategory: 'general' })
    expect(rowIds(html)).toEqual(['language', 'lowPerfMode', 'recording-launchAtLogin', 'recording-closeToTray', 'storageRoot'])
    for (const card of ['介面', '啟動與視窗', '儲存']) expect(html).toContain(`>${card}</h2>`)
    expect(html).toContain('class="set-cat-desc"')
  })

  test('category analysis: watch folders, auto analyze, decode, cache (4 rows)', async () => {
    const html = await render({ initialCategory: 'analysis' })
    expect(rowIds(html)).toEqual(['watchFolders', 'autoAnalyze', 'decode', 'cacheLocation'])
    expect(html).toContain('影片來源')
    expect(html).toContain('分析效能')
    // Watch folders come from getWatchFolders; missing folders are marked and each has a named remove button.
    expect(html).toContain('D:\\Outplayed\\Apex Legends')
    expect(html).toContain('找不到此資料夾')
    expect(html).toContain('aria-label="移除監看資料夾 D:\\Outplayed\\Apex Legends"')
    expect(html).toContain('新增資料夾')
  })

  test('category editing: proxy + clip defaults (6 rows) with usage text and steppers', async () => {
    const html = await render({ initialCategory: 'editing' })
    expect(rowIds(html)).toEqual(['proxySuggest', 'proxyUsage', 'beforeAfter', 'autoclip', 'autoSuggestOnOpen', 'projectAutosave'])
    expect(html).toContain('2.4 GB（3 個檔案）')
    expect(html).toContain('刪除全部代理檔')
    // Number input min/max values come from shared ranges.
    expect(html).toMatch(/id="set-beforeAfter-before"[^>]*min="0"[^>]*max="30"/)
    expect(html).toMatch(/id="set-autoclip-max_len"[^>]*min="15"[^>]*max="300"/)
    expect(html).toMatch(/id="set-autoclip-gap"[^>]*min="5"[^>]*max="60"/)
    expect(html).toMatch(/id="set-autoclip-n"[^>]*min="1"[^>]*max="10"/)
    expect(html).toContain('aria-label="減少事件前秒數"')
  })

  test('category export: encoders and OpenH264 state (2 rows)', async () => {
    const html = await render({ initialCategory: 'export' })
    expect(rowIds(html)).toEqual(['encoders', 'openh264'])
    expect(html).toContain('NVENC ✓')
    expect(html).toContain('QSV ✗')
    expect(html).toContain('已安裝')
    expect(html).not.toContain('data-row="defaultOutDir"')
  })

  test('category about: version, update, auto-update switch and trademark (4 rows)', async () => {
    const html = await render({ initialCategory: 'about' })
    expect(rowIds(html)).toEqual(['about', 'updateStatus', 'autoUpdate', 'trademark'])
    expect(html).toContain('Apex Legends 為 Electronic Arts／Respawn 之商標')
    expect(html).toMatch(/id="set-autoUpdate"[^>]*checked/)
    // Without an update API (old preload or development), show the unsupported state and provide the download page.
    expect(html).toContain('免安裝版與開發版不支援自動更新')
    expect(html).toContain('開啟下載頁面')
  })

  test('update row follows the status pushed by main: downloading → downloaded offers restart-and-update', async () => {
    let push: (s: UpdateStatus) => void = () => undefined
    const install = vi.fn(async () => true)
    const api = fakeApi()
    api.update = {
      getStatus: async () => ({ state: 'latest' }),
      check: async () => ({ state: 'latest' }),
      install,
      openReleases: async () => true,
      onStatus: (cb) => { push = cb; return () => undefined }
    }
    expect(await render({ initialCategory: 'about' }, api)).toContain('已是最新版本')
    const downloading = await render({ initialCategory: 'about' }, api, async () => push({ state: 'downloading', version: '0.2.0', percent: 40 }))
    expect(downloading).toContain('正在下載 0.2.0（40%）')
    expect(downloading).toMatch(/<button[^>]*id="set-updateStatus"[^>]*disabled/)
    const done = await render({ initialCategory: 'about' }, api, async (c) => {
      push({ state: 'downloaded', version: '0.2.0' })
      await c.installUpdate()
    })
    expect(done).toContain('0.2.0 已下載，結束 Aditor 時安裝')
    expect(done).toContain('立即重新啟動並更新')
    expect(install).toHaveBeenCalledTimes(1)
  })

  const storageRowHtml = (html: string): string => html.slice(html.indexOf('data-row="storageRoot"'))

  test('storage root row: unset shows the suggestion with a note and the three-folder preview, no open button', async () => {
    const api = fakeApi()
    api.settings.suggestStorageRoot = async () => 'D:\\Videos\\Aditor'
    const row = storageRowHtml(await render({ initialCategory: 'general' }, api))
    expect(row).toContain('尚未設定（建議：D:\\Videos\\Aditor）')
    expect(row).toContain('變更…')
    expect(row).not.toContain('在檔案總管開啟')
    expect(row).toContain('D:\\Videos\\Aditor\\Recordings\\日期')
    expect(row).toContain('D:\\Videos\\Aditor\\Exports\\Merged')
    expect(row).toContain('D:\\Videos\\Aditor\\Exports\\Clips')
    expect(row).toContain('錄影依日期分資料夾')
    expect(row).toContain('剪輯輸出：合併')
    expect(row).toContain('剪輯輸出：一段一段')
  })

  test('storage root row: configured root is shown with the open-in-explorer button', async () => {
    const row = storageRowHtml(await render({ initialCategory: 'general' }, fakeApi({ settings: { storageRoot: 'E:\\Apex' } })))
    expect(row).not.toContain('尚未設定')
    expect(row).toContain('在檔案總管開啟')
    expect(row).toContain('E:\\Apex\\Exports\\Merged')
  })

  test('the separate defaultOutDir and recording-outputDir rows are gone', () => {
    const ids = SETTING_ROWS.map((r) => r.id)
    expect(ids).not.toContain('defaultOutDir')
    expect(ids).not.toContain('recording-outputDir')
  })

  test('controls are real labelled form controls (label for, aria-describedby, role=switch checkbox)', async () => {
    const html = await render({ initialCategory: 'analysis' })
    expect(html).toMatch(/<label[^>]*for="set-autoAnalyze"[^>]*>新影片自動分析<\/label>/)
    expect(html).toMatch(/<input[^>]*id="set-autoAnalyze"[^>]*type="checkbox"[^>]*role="switch"/)
    expect(html).toMatch(/id="set-autoAnalyze"[^>]*aria-describedby="set-autoAnalyze-desc"/)
    expect(html).toMatch(/<label[^>]*for="set-decode"/)
    expect(html).toMatch(/<select[^>]*id="set-decode"/)
    expect(html).not.toMatch(/role="switch"[^>]*aria-checked/) // Native checked state should not be declared twice.
  })

  test('switch and select reflect the settings (checked / selected)', async () => {
    const api = (): SettingsApi => fakeApi({ settings: { autoAnalyze: false, lowPerfMode: true, decode: 'software' } })
    const analysis = await render({ initialCategory: 'analysis' }, api())
    expect(analysis).toMatch(/id="set-autoAnalyze"(?![^>]*checked)/)
    expect(analysis).toMatch(/<option value="software" selected/)
    expect(await render({ initialCategory: 'general' }, api())).toMatch(/id="set-lowPerfMode"[^>]*checked/)
  })

  test('tablist: role, label, six tabs, roving tabindex and aria-selected on the active one', async () => {
    const html = await render({ initialCategory: 'recording' })
    expect(html).toMatch(/role="tablist"[^>]*aria-label="設定分類"[^>]*aria-orientation="vertical"|aria-orientation="vertical"[^>]*role="tablist"/)
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0])
    expect(tabs).toHaveLength(6)
    expect(tabs[0]).toContain('aria-selected="false"')
    expect(tabs[0]).toContain('tabindex="-1"')
    expect(tabs[1]).toContain('aria-selected="true"')
    expect(tabs[1]).toContain('tabindex="0"')
    expect(tabs[1]).toContain('class="set-cat active"') // The red indicator is drawn by .active::before.
    expect(tabs[2]).toContain('tabindex="-1"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('aria-labelledby="set-tab-recording"')
    for (const label of ['一般', '錄影', '匯入與分析', '剪輯', '匯出', '關於']) expect(html).toContain(`>${label}</span>`)
  })

  test('only the active category rows are rendered without a search', async () => {
    const html = await render({ initialCategory: 'general' })
    expect(html).not.toContain('data-row="proxySuggest"')
    expect(html).not.toContain('data-row="encoders"')
  })

  test('search results: rows from ALL categories, grouped by card, with per-category hit counts', async () => {
    const html = await render({ initialQuery: '資料夾' })
    // Storage location (General) and watch folders (Import and analysis).
    expect(rowIds(html)).toEqual(['storageRoot', 'watchFolders'])
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="搜尋結果"')
    expect(html).not.toContain('role="tabpanel"')
    expect(html).not.toContain('class="set-cat-desc"')
    // Show only matching rows; other rows in the same card are filtered out.
    expect(html).not.toContain('data-row="autoAnalyze"')
    expect(html).toContain('影片來源') // Keep the card title.
    // One match in each category: General and Import and analysis.
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>.*?<\/button>/g)].map((m) => m[0])
    expect(tabs[0]).toMatch(/aria-label="1 項符合">1</)
    expect(tabs[1]).not.toContain('set-hit')
    expect(tabs[2]).toMatch(/aria-label="1 項符合">1</)
    expect(tabs[3]).not.toContain('set-hit')
  })

  test('search matches keywords case-insensitively (NVENC → encoders row)', async () => {
    const html = await render({ initialQuery: 'nvenc' })
    expect(rowIds(html)).toEqual(['encoders'])
  })

  test('Search with no match shows “No matching settings” and no rows', async () => {
    const html = await render({ initialQuery: 'zzzz-not-a-setting' })
    expect(html).toContain('沒有符合的設定')
    expect(rowIds(html)).toEqual([])
    expect(html).not.toContain('class="set-hit"')
  })

  test('no setting row is left hard-disabled; OpenH264 download is actionable', async () => {
    const html = (await render({ initialCategory: 'about' })) + (await render({ initialCategory: 'export' }))
    // Third-party licenses (I11) is active rather than disabled.
    expect(html).not.toMatch(/<button[^>]*id="set-about"[^>]*disabled/)
    expect(html).not.toContain('授權清單頁面將在後續更新提供。')
    // The OpenH264 download button is enabled; settings can start the download after showing the license notice.
    expect(html).not.toMatch(/<button[^>]*id="set-openh264"[^>]*disabled/)
    expect(html).not.toContain('下載需在匯出面板同意授權後進行。')
  })

  test('The developer note “IPC needs to be added” never appears in category or search markup', async () => {
    for (const cat of ['general', 'recording', 'analysis', 'editing', 'export', 'about'] as const) {
      expect(await render({ initialCategory: cat })).not.toContain('需新增 IPC')
    }
    expect(await render({ initialQuery: '設定' })).not.toContain('需新增 IPC')
  })

  test('New settings carry the “New” tag (low-performance, auto-suggest, autosave)', async () => {
    const b = await render({ initialCategory: 'editing' })
    expect((b.match(/class="set-newtag"/g) ?? []).length).toBe(2)
  })
})

describe('save-failed notice and state sync', () => {
  test('persisted:false → save-failure notice in an aria-live region; control shows the returned value', async () => {
    const html = await render({ initialCategory: 'general' }, fakeApi({ persisted: false }), async (c) => {
      await c.setBool('lowPerfMode', true)
    })
    expect(html).toContain('儲存失敗')
    expect(html).toMatch(/class="set-notice-host"[^>]*role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*class="set-notice-host"|role="status"[^>]*class="set-notice-host"/)
    expect(html).toMatch(/id="set-lowPerfMode"[^>]*checked/)
  })

  test('persisted:true → no notice', async () => {
    const html = await render({ initialCategory: 'general' }, fakeApi(), async (c) => {
      await c.setBool('lowPerfMode', true)
    })
    expect(html).not.toContain('儲存失敗')
    // Keep the live region container present and empty so later inserted messages are announced.
    expect(html).toContain('set-notice-host')
  })

  test('a backend that rejects the change leaves the control at the returned (old) value', async () => {
    const api = fakeApi()
    api.settings.set = async () => ({ settings: { ...DEFAULT_SETTINGS, lowPerfMode: false }, persisted: true })
    const html = await render({ initialCategory: 'general' }, api, async (c) => {
      await c.setBool('lowPerfMode', true)
    })
    expect(html).toMatch(/id="set-lowPerfMode"(?![^>]*checked)/)
  })

  test('numeric inputs show the clamped value returned by main, never the typed 99', async () => {
    const html = await render({ initialCategory: 'editing' }, fakeApi(), async (c) => {
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
      errors: { storageRoot: '無法建立或寫入儲存位置：Z:\\nope' }
    })
    const html = await render({ initialCategory: 'general' }, api, async (c) => {
      await c.pickStorageRoot()
    })
    expect(html).toMatch(/<p[^>]*class="set-err"[^>]*role="alert"[^>]*>無法建立或寫入儲存位置：Z:\\nope<\/p>/)
    expect(html).toMatch(/id="set-storageRoot"[^>]*aria-describedby="[^"]*set-storageRoot-err/)
  })

  test('load failure shows defaults plus a notice', async () => {
    const api = fakeApi()
    api.settings.get = async () => {
      throw new Error('x')
    }
    const html = await render({ initialCategory: 'analysis' }, api)
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
    ['settings:suggestStorageRoot'],
    ['proxy:usage'],
    ['proxy:delete'],
    ['library:getWatchFolders'],
    ['library:addWatchFolder'],
    ['library:removeWatchFolder'],
    ['library:getEntries'],
    ['export:detectEncoders'],
    ['export:selectOutDir'],
    ['export:openFolder'],
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
    for (const name of ['getEntries', 'getWatchFolders', 'addWatchFolder', 'removeWatchFolder', 'usage', 'detectEncoders', 'selectOutDir', 'openh264Status', 'downloadOpenH264', 'onOpenH264Progress', 'onChanged']) {
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
