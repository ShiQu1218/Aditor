import fs from 'fs'
import os from 'os'
import path from 'path'
import { test, expect, importAndAnalyze, openStudio, card, waitProjectFile, readSettings } from './helpers/test'
import { isAlive } from './helpers/launch'
import { i18n, shellI18n } from '../src/renderer/i18n'

type AnyApi = { queue: { enqueue: (p: string) => Promise<unknown>; cancel: (p: string) => Promise<unknown> }; export: { start: (o: unknown) => Promise<{ ok: boolean; code?: string }> } }

test('closing the window within 500 ms of an edit still restores the project after relaunch', async ({ launch, videos }) => {
  const app = await launch()
  const { page } = app
  await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
  await openStudio(page, 'E2E clip A')
  await page.keyboard.press('Enter')
  const t0 = Date.now()
  await expect(page.locator('.pclip')).toHaveCount(1)
  await app.closeWindow() // Close immediately: debounce has not fired, so persistence relies on flushSync/the close handshake.
  // The interval between editing and the close command is far shorter than the 500 ms debounce (otherwise this case is meaningless).
  expect(Date.now() - t0).toBeLessThan(450)
  const saved = await waitProjectFileOffline(app.projectsDir, 1)
  expect(saved.id).toMatch(/^p_/)
  const app2 = await launch({ root: app.root })
  await expect(app2.page.locator('.rail-btn .badge')).toHaveText('1')
  await openStudio(app2.page, 'E2E clip A')
  await expect(app2.page.locator('.pclip')).toHaveCount(1)
  // lastProjectId matches the project file on disk and remains consistent after restart.
  expect(readSettings(app2).lastProjectId).toBe(saved.id)
})

async function waitProjectFileOffline(dir: string, items: number): Promise<{ id: string }> {
  let id = ''
  await expect
    .poll(() => {
      try {
        for (const n of fs.readdirSync(dir)) {
          if (!/^[A-Za-z0-9_-]+\.json$/.test(n)) continue
          const doc = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8'))
          if (doc.items?.length === items) {
            id = n.replace(/\.json$/, '')
            return true
          }
        }
      } catch {
        /* Not written yet. */
      }
      return false
    })
    .toBe(true)
  return { id }
}

test('hand-corrupted project file: backup .bak.<ts>.json is created and the app still starts', async ({ launch }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-corrupt-'))
  try {
    const projects = path.join(root, 'Aditor', 'projects')
    fs.mkdirSync(projects, { recursive: true })
    fs.writeFileSync(path.join(projects, 'p_corrupt.json'), '{ this is : not json', 'utf-8')
    const app = await launch({ root, ownRoot: true, settings: { lastProjectId: 'p_corrupt' } })
    await expect(app.page.locator('.lib-empty')).toBeVisible()
    await expect
      .poll(() => fs.readdirSync(projects).filter((n) => /^p_corrupt\.bak\.\d+\.json$/.test(n)).length)
      .toBe(1)
    expect(fs.existsSync(path.join(projects, 'p_corrupt.json'))).toBe(false)
    await expect(app.page.locator('.rail-btn .badge')).toHaveCount(0) // Back to a blank new project.
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true })
    throw e
  }
})

test('export cancel kills the fake-ffmpeg process tree and removes .partial; a second export is refused', async ({ launch, videos }) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-out-'))
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-pid-'))
  try {
    const app = await launch({
      fakeExport: true,
      settings: { defaultOutDir: outDir },
      env: { FAKE_FFMPEG_SLEEP_MS: '120000', FAKE_FFMPEG_GRANDCHILD: '1', FAKE_FFMPEG_PID_DIR: pidDir }
    })
    const { page } = app
    await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
    await openStudio(page, 'E2E clip A')
    await page.keyboard.press('Enter')
    const proj = await waitProjectFile(app, 1)
    await page.keyboard.press('Control+Shift+E')
    const drawer = page.locator('.xd')
    await drawer.getByRole('button', { name: i18n.export.startExport }).click()
    await expect(drawer).toHaveAttribute('data-phase', 'running')
    await expect.poll(() => fs.readdirSync(pidDir).length).toBe(1)
    const pids = JSON.parse(fs.readFileSync(path.join(pidDir, fs.readdirSync(pidDir)[0]), 'utf-8')) as { ffmpeg: number; grandchild: number }
    expect(isAlive(pids.ffmpeg)).toBe(true)
    expect(isAlive(pids.grandchild)).toBe(true)

    // Starting another export while one is in progress is rejected (only one export at a time).
    const second = await page.evaluate(
      (o) => (window as unknown as { api: AnyApi }).api.export.start(o),
      { items: proj.items, mode: 'concat', quality: 'copy', outDir, baseName: 'second' }
    )
    expect(second.ok).toBe(false)
    expect(second.code).toBe('busy')

    await drawer.getByRole('button', { name: i18n.export.cancelExport }).click()
    await expect(drawer).toHaveAttribute('data-phase', 'done')
    await expect.poll(() => isAlive(pids.ffmpeg), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => isAlive(pids.grandchild), { timeout: 10_000 }).toBe(false)
    expect(fs.readdirSync(outDir)).toEqual([])
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.rmSync(pidDir, { recursive: true, force: true })
  }
})

test('re-analysis: cancel mid-way then complete keeps the accepted AI clip as stale and recomputes suggestions once', async ({ launch, videos }) => {
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-gate-'))
  try {
    const app = await launch({ env: { FAKE_ENGINE_GATE_DIR: gate } })
    const { page } = app
    const video = videos.videos[0]
    await importAndAnalyze(page, [video.path], [video.title])
    await openStudio(page, video.title)
    await expect(page.locator('.hl-card')).toHaveCount(3)
    await page.keyboard.press('Enter') // Add the first suggestion.
    await expect(page.locator('.hl-card .hl-badge.accepted')).toHaveCount(1)

    const cacheFile = path.join(app.cacheDir, fs.readdirSync(app.cacheDir).find((n) => /^[0-9a-f]{40}\.json$/.test(n))!)
    const readCache = (): { clips: Array<{ id: string; status?: string; stale?: boolean; origin: string }>; app?: { suggestionsPending?: boolean }; analysis: { status: string; templates_version: string } } =>
      JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
    await expect.poll(() => readCache().clips.filter((c) => c.status === 'accepted').length, { timeout: 10_000 }).toBe(1)
    const acceptedId = readCache().clips.find((c) => c.status === 'accepted')!.id

    // Return to the library; simulate a template version update that expires the cache (the engine then reanalyzes).
    await page.getByRole('button', { name: shellI18n.rail.library, exact: true }).click()
    const doc = readCache()
    doc.analysis.templates_version = 'zh-TW@old'
    fs.writeFileSync(cacheFile, JSON.stringify(doc), 'utf-8')

    // Reanalyze and cancel midway.
    fs.writeFileSync(path.join(gate, 'hold'), '')
    await page.evaluate((p) => (window as unknown as { api: AnyApi }).api.queue.enqueue(p), video.path)
    await expect(card(page, video.title).locator('.vcard-progress')).toBeVisible()
    await page.evaluate((p) => (window as unknown as { api: AnyApi }).api.queue.cancel(p), video.path)
    await expect(card(page, video.title).locator('.vcard-progress')).toHaveCount(0)
    await expect.poll(() => readCache().analysis.status).toBe('partial') // Cancellation writes partial status (only manual clips remain).

    // Run it again and let it finish.
    fs.rmSync(path.join(gate, 'hold'), { force: true })
    await page.evaluate((p) => (window as unknown as { api: AnyApi }).api.queue.enqueue(p), video.path)
    await expect(card(page, video.title).locator('.vcard-counts')).toBeVisible()
    await expect.poll(() => readCache().analysis.status).toBe('done')
    const merged = readCache()
    expect(merged.app?.suggestionsPending).toBe(true)
    const kept = merged.clips.find((c) => c.id === acceptedId)
    expect(kept).toMatchObject({ status: 'accepted', stale: true })

    // Open Studio: restore added AI clips as stale and recompute suggestions only once.
    await openStudio(page, video.title)
    const stale = page.locator('.hl-card', { hasText: i18n.studio.hl.stale })
    await expect(stale).toHaveCount(1)
    await expect(stale.locator('.hl-badge.accepted')).toBeVisible()
    await expect.poll(() => page.locator('.hl-card').count()).toBeGreaterThan(1)
    const count = await page.locator('.hl-card').count()
    await expect.poll(() => readCache().app?.suggestionsPending ?? false, { timeout: 10_000 }).toBe(false)
    // Close and reopen: do not merge again (the clip count stays the same with no duplicates).
    await page.getByRole('button', { name: i18n.studio.back }).click()
    await openStudio(page, video.title)
    await expect(page.locator('.hl-card')).toHaveCount(count)
    await expect(page.locator('.hl-card', { hasText: i18n.studio.hl.stale })).toHaveCount(1)
  } finally {
    fs.rmSync(gate, { recursive: true, force: true })
  }
})

test('export with the real ffmpeg: quick lossless export finishes and leaves one playable file, no partial', async ({ launch, videos }) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-out-'))
  try {
    const app = await launch({ settings: { defaultOutDir: outDir } })
    const { page } = app
    await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
    await openStudio(page, 'E2E clip A')
    await page.keyboard.press('Enter')
    await expect(page.locator('.pclip')).toHaveCount(1)
    await page.keyboard.press('Control+Shift+E')
    const drawer = page.locator('.xd')
    await drawer.getByRole('button', { name: i18n.export.startExport }).click()
    await expect(drawer).toHaveAttribute('data-phase', 'done', { timeout: 60_000 })
    await expect(drawer.getByRole('heading', { name: i18n.export.doneTitle })).toBeVisible()
    const files = fs.readdirSync(outDir)
    expect(files.filter((n) => n.endsWith('.mp4') && !n.includes('.partial'))).toHaveLength(1)
    expect(files.filter((n) => n.includes('.partial'))).toEqual([])
    expect(fs.statSync(path.join(outDir, files[0])).size).toBeGreaterThan(1000)
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})
