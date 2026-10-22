import fs from 'fs'
import os from 'os'
import path from 'path'
import { test, expect, importAndAnalyze, card, openStudio, shot, waitProjectFile, readSettings, listFilesDeep } from './helpers/test'
import { i18n, settingsI18n, shellI18n } from '../src/renderer/i18n'

const T = i18n.studio

test('smoke: app launches, library empty state visible, rail navigable by keyboard', async ({ launch }) => {
  const { page } = await launch()
  await expect(page.locator('.lib-empty')).toBeVisible()
  // Brand assets must load in a production build with CSP enabled.
  await expect(page.locator('.rail img.logo')).toBeVisible()
  await expect.poll(() => page.locator('.rail img.logo').evaluate(
    (img: HTMLImageElement) => img.complete && img.naturalWidth > 0
  )).toBe(true)
  await expect(page.locator('.rail .app-icon-analysis-queue')).toBeVisible()
  await expect(page.locator('.rail .queue-progress')).toBeHidden()
  await shot(page, 'smoke-empty')
  const rail = shellI18n.rail
  // Keyboard only: focus a rail button and press Enter to switch pages.
  await page.getByRole('button', { name: rail.settings, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.set-screen')).toBeVisible()
  await expect(page.getByRole('button', { name: rail.settings, exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: rail.library, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.lib-screen')).toBeVisible()
  // With an empty library, Studio shows its empty state with a way back to the library.
  await page.getByRole('button', { name: rail.studioLabel, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.studio-blocked')).toContainText(i18n.studio.empty)
  await page.getByRole('button', { name: i18n.studio.back, exact: true }).focus()
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
  // Engine-shaped result: elimination/assist badges and a lazy N-highlight count.
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
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-gate-'))
  fs.writeFileSync(path.join(gate, 'hold'), '')
  try {
    const { page } = await launch({ env: { FAKE_ENGINE_GATE_DIR: gate } })
    const v = videos.videos[0]
    await page.evaluate((p) => (window as unknown as { api: { library: { add: (x: string[]) => Promise<unknown> } } }).api.library.add(p), [v.path])
    const c = card(page, v.title)
    await expect(c.locator('.vcard-progress')).toBeVisible()
    // The primary button uses aria-disabled during analysis (not native disabled), so a real user can still click it; expect only a toast.
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
  // The engine document has only manual clips; autoclip automatically places these three suggestions.
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
  await page.keyboard.press('Enter') // Native button: preview (seek), not add.
  await expect(page.locator('.pclip')).toHaveCount(0)
  await expect(page.locator('.hl-card .hl-badge.suggested')).toHaveCount(3)
  // Same for the top-bar button: Enter performs its own action (collapse the sidebar).
  await page.getByRole('button', { name: T.asideToggle }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.studio-aside')).toHaveCount(0)
  await expect(page.locator('.pclip')).toHaveCount(0)
  await expect(page.locator('.toast', { hasText: '已加入專案' })).toHaveCount(0)
})

test('Ctrl+Q in project mode splits; in source mode toggles blade mode, whose two clicks add a clip with undo toast', async ({ launch, videos }) => {
  const { page } = await launch()
  await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
  await openStudio(page, 'E2E clip A')
  // Source mode: Ctrl+Q turns on blade mode; two clicks on the timeline mark the clip's start and end.
  await page.keyboard.press('Control+q')
  await expect(page.locator(`.transport button[title="${i18n.timeline.bladeHint}"]`)).toHaveAttribute('aria-pressed', 'true')
  const box = (await page.locator('.tl-wrap').boundingBox())!
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2)
  await expect(page.locator('.pclip')).toHaveCount(1)
  await expect(page.locator('.hl-card')).toHaveCount(4)
  const t = page.locator('.toast', { hasText: '已加入專案' })
  await expect(t).toBeVisible()
  await t.getByRole('button', { name: T.toast.undo }).click()
  await expect(page.locator('.pclip')).toHaveCount(0)
  await expect(page.locator('.hl-card')).toHaveCount(3)
  // Project mode: add and preview a clip, then split it.
  await page.locator('.hl-card.active').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.pclip')).toHaveCount(1)
  // Enter project mode by keyboard (the toast temporarily covers the project track's lower-left corner and intercepts mouse clicks).
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
  await expect(app2.page.locator('.rail-btn .badge')).toHaveText('1') // Number of project clips on the Studio icon.
  await openStudio(app2.page, 'E2E clip A')
  await expect(app2.page.locator('.pclip')).toHaveCount(1)
})

test('export drawer: start export with fake ffmpeg, cancel, partial file removed', async ({ launch, videos }) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-out-'))
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-pid-'))
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
    // The fake ffmpeg has started and written a partial output.
    await expect.poll(() => listFilesDeep(outDir).some((n) => n.endsWith('.partial.mp4'))).toBe(true)
    await drawer.getByRole('button', { name: i18n.export.cancelExport }).click()
    await expect(drawer).toHaveAttribute('data-phase', 'done')
    await expect(drawer.getByRole('heading', { name: i18n.export.cancelledTitle })).toBeVisible()
    expect(listFilesDeep(outDir)).toEqual([])
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
  // Search filtering.
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
  // Remains open after restart.
  await app.closeWindow()
  const app2 = await launch({ root: app.root })
  await expect(app2.page.locator('html')).toHaveAttribute('data-lowperf', /.*/)
  await app2.page.getByRole('button', { name: shellI18n.rail.settings, exact: true }).click()
  await expect(app2.page.locator('#set-lowPerfMode')).toBeChecked()
})

test('1366x768: project track collapsed by default; export drawer does not cover top bar', async ({ launch, videos }) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-out-'))
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
