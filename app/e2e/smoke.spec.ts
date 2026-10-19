import fs from 'fs'
import os from 'os'
import path from 'path'
import { test, expect, importAndAnalyze, card, openStudio, shot, waitProjectFile, readSettings } from './helpers/test'
import { i18n, settingsI18n, shellI18n } from '../src/renderer/i18n'

const T = i18n.studio

test('smoke: app launches, library empty state visible, rail navigable by keyboard', async ({ launch }) => {
  const { page } = await launch()
  await expect(page.locator('.lib-empty')).toBeVisible()
  // 品牌資產需在正式建置與 CSP 下成功載入。
  await expect(page.locator('.rail img.logo')).toBeVisible()
  await expect.poll(() => page.locator('.rail img.logo').evaluate(
    (img: HTMLImageElement) => img.complete && img.naturalWidth > 0
  )).toBe(true)
  await expect(page.locator('.rail .app-icon-analysis-queue')).toBeVisible()
  await expect(page.locator('.rail .queue-progress')).toBeHidden()
  await shot(page, 'smoke-empty')
  const rail = shellI18n.rail
  // 純鍵盤：聚焦圖示欄按鈕 → Enter 切換頁面
  await page.getByRole('button', { name: rail.settings, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.set-screen')).toBeVisible()
  await expect(page.getByRole('button', { name: rail.settings, exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: rail.library, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.lib-screen')).toBeVisible()
  // 尚未選擇影片時「工作室」回到影片庫
  await page.getByRole('button', { name: rail.studioLabel, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.lib-screen')).toBeVisible()
})

test('import fixtures via IPC → cards appear → analysis (fake engine) completes → card clickable', async ({ launch, videos }) => {
  const { page } = await launch()
  await importAndAnalyze(
    page,
    videos.videos.map((v) => v.path),
    videos.videos.map((v) => v.title)
  )
  await expect(page.locator('.vcard')).toHaveCount(3)
  // 引擎形狀的結果：擊倒／助攻徽章與惰性 N 精華
  const a = card(page, 'E2E clip A')
  await expect(a.locator('.vbadge.knock')).toBeVisible()
  await expect(a.locator('.vbadge.assist')).toBeVisible()
  await expect(a.locator('.vbadge.hl')).toHaveText(/3 精華/)
  await shot(page, 'library-3-done')
  await a.locator('.vcard-open').click()
  await expect(page.locator('.studio')).toBeVisible()
  await expect(page.locator('.studio-file')).toHaveText('E2E clip A.mp4')
  await expect(page.locator('.studio-meta')).toContainText('300 個事件')
})

test('analyzing card click shows toast and does not open studio', async ({ launch, videos }) => {
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-e2e-gate-'))
  fs.writeFileSync(path.join(gate, 'hold'), '')
  try {
    const { page } = await launch({ env: { FAKE_ENGINE_GATE_DIR: gate } })
    const v = videos.videos[0]
    await page.evaluate((p) => (window as unknown as { api: { library: { add: (x: string[]) => Promise<unknown> } } }).api.library.add(p), [v.path])
    const c = card(page, v.title)
    await expect(c.locator('.vcard-progress')).toBeVisible()
    // 分析中的主按鈕是 aria-disabled（非原生 disabled）：真實使用者仍可點擊，要求只顯示 Toast
    await c.locator('.vcard-open').click({ force: true })
    await expect(page.locator('.toast', { hasText: i18n.library.card.openBlocked })).toBeVisible()
    await expect(page.locator('.studio')).toHaveCount(0)
    await expect(page.locator('.lib-screen')).toBeVisible()
  } finally {
    fs.rmSync(path.join(gate, 'hold'), { force: true })
    fs.rmSync(gate, { recursive: true, force: true })
  }
})

test('open studio → suggestions auto-placed → Enter accepts → project track has item → Ctrl+Z removes it', async ({ launch, videos }) => {
  const { page } = await launch()
  await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
  await openStudio(page, 'E2E clip A')
  // 引擎文件只有手動片段：這 3 張建議由 autoclip 自動放置
  await expect(page.locator('.hl-card')).toHaveCount(3)
  await expect(page.locator('.hl-card .hl-badge.suggested')).toHaveCount(3)
  await expect(page.locator('.hl-card.active')).toBeFocused()
  await expect(page.locator('.pclip')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.locator('.pclip')).toHaveCount(1)
  await expect(page.locator('.toast', { hasText: '已加入專案' })).toBeVisible()
  await expect(page.locator('.hl-card .hl-badge.accepted')).toHaveCount(1)
  await shot(page, 'studio-accepted')
  await page.keyboard.press('Control+z')
  await expect(page.locator('.pclip')).toHaveCount(0)
})

test('keyboard matrix: Enter on a focused button does not accept suggestion', async ({ launch, videos }) => {
  const { page } = await launch()
  await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
  await openStudio(page, 'E2E clip A')
  const preview = page.locator('.hl-card.active .hl-preview')
  await preview.focus()
  await expect(preview).toBeFocused()
  await page.keyboard.press('Enter') // 原生按鈕：預覽（seek），不是「加入」
  await expect(page.locator('.pclip')).toHaveCount(0)
  await expect(page.locator('.hl-card .hl-badge.suggested')).toHaveCount(3)
  // 頂欄按鈕同理：Enter 只做按鈕本身的事（收起側欄）
  await page.getByRole('button', { name: T.asideToggle }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.studio-aside')).toHaveCount(0)
  await expect(page.locator('.pclip')).toHaveCount(0)
  await expect(page.locator('.toast', { hasText: '已加入專案' })).toHaveCount(0)
})

test('Ctrl+Q in project mode splits; in source mode adds a quick clip with undo toast', async ({ launch, videos }) => {
  const { page } = await launch()
  await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
  await openStudio(page, 'E2E clip A')
  // 來源模式：快速剪輯＋〔復原〕
  await page.keyboard.press('Control+q')
  await expect(page.locator('.pclip')).toHaveCount(1)
  await expect(page.locator('.hl-card')).toHaveCount(4)
  const t = page.locator('.toast', { hasText: '已加入專案' })
  await expect(t).toBeVisible()
  await t.getByRole('button', { name: T.toast.undo }).click()
  await expect(page.locator('.pclip')).toHaveCount(0)
  await expect(page.locator('.hl-card')).toHaveCount(3)
  // 專案模式：先加入一段並預覽，再分割
  await page.locator('.hl-card.active').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.pclip')).toHaveCount(1)
  // 以鍵盤進入專案模式（Toast 暫時蓋住專案軌左下角，滑鼠點擊會被攔截）
  await page.locator('.pclip').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.mode-pill.is-project')).toBeVisible()
  await page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement
    v.pause()
    v.currentTime = v.currentTime + 1
  })
  await expect.poll(() => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).seeking)).toBe(false)
  await page.locator('.pclip').focus()
  await page.keyboard.press('Control+q')
  await expect(page.locator('.pclip')).toHaveCount(2)
})

test('project autosave: item added, app restarted, project restored', async ({ launch, videos }) => {
  const app = await launch()
  const { page } = app
  await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
  await openStudio(page, 'E2E clip A')
  await page.keyboard.press('Enter')
  await expect(page.locator('.pclip')).toHaveCount(1)
  const saved = await waitProjectFile(app, 1)
  await expect.poll(() => readSettings(app).lastProjectId).toBe(saved.id)
  await app.closeWindow()
  const app2 = await launch({ root: app.root })
  await expect(app2.page.locator('.rail-btn .badge')).toHaveText('1') // 工作室圖示上的專案片段數
  await openStudio(app2.page, 'E2E clip A')
  await expect(app2.page.locator('.pclip')).toHaveCount(1)
})

test('export drawer: start export with fake ffmpeg, cancel, partial file removed', async ({ launch, videos }) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-e2e-out-'))
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-e2e-pid-'))
  try {
    const app = await launch({
      fakeExport: true,
      settings: { defaultOutDir: outDir },
      env: { FAKE_FFMPEG_SLEEP_MS: '120000', FAKE_FFMPEG_PID_DIR: pidDir }
    })
    const { page } = app
    await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
    await openStudio(page, 'E2E clip A')
    await page.keyboard.press('Enter')
    await expect(page.locator('.pclip')).toHaveCount(1)
    await page.keyboard.press('Control+Shift+E')
    const drawer = page.locator('.xd')
    await expect(drawer).toHaveAttribute('data-phase', 'settings')
    const start = drawer.getByRole('button', { name: i18n.export.startExport })
    await expect(start).toBeEnabled()
    await start.click()
    await expect(drawer).toHaveAttribute('data-phase', 'running')
    // 假 ffmpeg 已啟動並寫出半成品
    await expect.poll(() => fs.readdirSync(outDir).some((n) => n.endsWith('.partial.mp4'))).toBe(true)
    await drawer.getByRole('button', { name: i18n.export.cancelExport }).click()
    await expect(drawer).toHaveAttribute('data-phase', 'done')
    await expect(drawer.getByRole('heading', { name: i18n.export.cancelledTitle })).toBeVisible()
    expect(fs.readdirSync(outDir)).toEqual([])
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.rmSync(pidDir, { recursive: true, force: true })
  }
})

test('settings: change low-perf mode, restart, value persisted; search filters rows', async ({ launch }) => {
  const app = await launch()
  const { page } = app
  await page.getByRole('button', { name: shellI18n.rail.settings, exact: true }).click()
  const sw = page.locator('#set-lowPerfMode')
  await expect(sw).not.toBeChecked()
  await sw.check()
  await expect(page.locator('html')).toHaveAttribute('data-lowperf', /.*/)
  await expect.poll(() => readSettings(app).lowPerfMode).toBe(true)
  // 搜尋過濾
  const rows = page.locator('.set-row')
  await page.locator('#set-search').fill('低效能')
  await expect(page.locator('.set-row[data-row="lowPerfMode"]')).toBeVisible()
  const filtered = await rows.count()
  await page.locator('#set-search').fill('')
  await expect.poll(() => rows.count()).toBeGreaterThan(filtered)
  await page.locator('#set-search').fill('zzzz-no-such-setting')
  await expect(rows).toHaveCount(0)
  await expect(page.getByText(settingsI18n.noResults)).toBeVisible()
  await page.locator('#set-search').fill('')
  // 重啟後仍為開啟
  await app.closeWindow()
  const app2 = await launch({ root: app.root })
  await expect(app2.page.locator('html')).toHaveAttribute('data-lowperf', /.*/)
  await app2.page.getByRole('button', { name: shellI18n.rail.settings, exact: true }).click()
  await expect(app2.page.locator('#set-lowPerfMode')).toBeChecked()
})

test('1366x768: project track collapsed by default; export drawer does not cover top bar', async ({ launch, videos }) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-e2e-out-'))
  try {
    const app = await launch({ size: { width: 1366, height: 768 }, settings: { defaultOutDir: outDir } })
    const { page } = app
    await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
    await openStudio(page, 'E2E clip A')
    await expect(page.locator('.project-lane')).toHaveClass(/collapsed/)
    await shot(page, 'studio-1366x768')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+Shift+E')
    const drawer = page.locator('.xd')
    await expect(drawer).toBeVisible()
    const head = (await page.locator('.studio-head').boundingBox())!
    const box = (await drawer.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(head.y + head.height - 1)
    await shot(page, 'export-drawer-1366x768')
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})

test('security (I2): CSP is applied, in-page navigation to a file is blocked, window.open denied', async ({ launch }) => {
  const { page } = await launch()
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("default-src 'self'")
  expect(csp).not.toContain('unsafe-eval')
  const before = page.url()
  await page.evaluate(() => {
    window.location.href = 'file:///C:/Windows/win.ini'
  })
  await page.waitForTimeout(500)
  expect(page.url()).toBe(before)
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => !!document.querySelector('.lib-empty'))).toBe(true)
  const opened = await page.evaluate(() => window.open('https://example.com/') === null)
  expect(opened).toBe(true)
  expect(await page.evaluate(() => typeof (window as unknown as { api?: unknown }).api)).toBe('object')
})
