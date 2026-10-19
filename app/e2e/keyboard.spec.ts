import fs from 'fs'
import path from 'path'
import { test, expect, importAndAnalyze, openStudio, videoTime, readSettings } from './helpers/test'
import { i18n } from '../src/renderer/i18n'

type Api = { settings: { set: (p: unknown) => Promise<unknown> } }

test('shortcuts dialog opens with ? and closes with Esc (library and studio)', async ({ launch, videos }) => {
  const { page } = await launch()
  await page.keyboard.press('?')
  const dlg = page.locator('.sc-dialog')
  await expect(dlg).toBeVisible()
  await expect(dlg.getByRole('heading', { name: '快捷鍵說明' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)

  await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
  await openStudio(page, 'E2E clip A')
  await page.keyboard.press('?')
  await expect(dlg).toBeVisible()
  // Studio shortcuts are inactive while a dialog is open (Enter does not add a suggestion).
  await page.keyboard.press('Control+q')
  await expect(page.locator('.pclip')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  await expect(page.locator('.studio')).toBeVisible()
})

test('library keyboard grid navigation: arrows, Home and End move the roving cursor', async ({ launch, videos }) => {
  const { page } = await launch()
  await importAndAnalyze(
    page,
    videos.videos.map((v) => v.path),
    videos.videos.map((v) => v.title)
  )
  const activePath = (): Promise<string | undefined> =>
    page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.vcard')?.dataset.vcardPath)
  // Only the active card's primary button is in the Tab order (roving tabindex).
  await expect(page.locator('.vcard-open[tabindex="0"]')).toHaveCount(1)
  await page.locator('.vcard-open[tabindex="0"]').focus()
  const first = await activePath()
  await page.keyboard.press('ArrowRight')
  const second = await activePath()
  expect(second).toBeTruthy()
  expect(second).not.toBe(first)
  await page.keyboard.press('End')
  const last = await activePath()
  expect(last).not.toBe(second)
  await page.keyboard.press('Home')
  await expect.poll(activePath).toBe(first)
  await page.keyboard.press('ArrowLeft') // Already on the first card: stay in place and keep focus.
  expect(await activePath()).toBe(first)
  await expect(page.locator('.vcard-open[tabindex="0"]')).toHaveCount(1)
  // Enter opens the active card.
  await page.keyboard.press('Enter')
  await expect(page.locator('.studio')).toBeVisible()
})

test('timeline keyboard: Ctrl+→ advances through events (and Ctrl+← goes back)', async ({ launch, videos }) => {
  const app = await launch({ env: { FAKE_ENGINE_EVENTS: '12' } })
  const { page } = app
  await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
  const cacheFile = fs.readdirSync(app.cacheDir).find((n) => n.endsWith('.json') && !n.includes('.clips.'))!
  const doc = JSON.parse(fs.readFileSync(path.join(app.cacheDir, cacheFile), 'utf-8')) as { events: Array<{ t: number }> }
  const times = doc.events.map((e) => e.t).sort((a, b) => a - b)
  expect(times).toHaveLength(12)
  await openStudio(page, 'E2E clip A')
  const before = 1 // Test setting before=1: place the playhead one second before the event.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Control+ArrowRight')
    await expect.poll(async () => Math.abs((await videoTime(page)) - Math.max(0, times[i] - before)), { timeout: 5000 }).toBeLessThan(0.12)
  }
  // Every press advances to the next event instead of getting stuck on the same one.
  await page.keyboard.press('Control+ArrowLeft')
  await expect.poll(async () => Math.abs((await videoTime(page)) - Math.max(0, times[4] - before)), { timeout: 5000 }).toBeLessThan(0.12)
})

test('Esc during a timeline drag cancels the drag and does not leave project mode', async ({ launch, videos }) => {
  const { page } = await launch()
  await importAndAnalyze(page, [videos.videos[0].path], ['E2E clip A'])
  await openStudio(page, 'E2E clip A')
  await page.keyboard.press('Enter')
  await expect(page.locator('.pclip')).toHaveCount(1)
  await page.locator('.pclip').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.mode-pill.is-project')).toBeVisible()

  const box = (await page.locator('.tl-wrap').boundingBox())!
  const y = box.y + 14
  await page.mouse.move(box.x + 60, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 200, y, { steps: 6 })
  await expect(page.locator('.tl-boxsel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.tl-boxsel')).toHaveCount(0)
  await expect(page.locator('.mode-pill.is-project')).toBeVisible() // This Esc only cancels the gesture.
  await page.mouse.up()
  await expect(page.locator('.mode-pill.is-project')).toBeVisible()
  // Press Esc again to return to the source.
  await page.keyboard.press('Escape')
  await expect(page.locator('.mode-pill.is-source')).toBeVisible()
})

test('low-perf first-run prompt appears when hardware decode is unavailable', async ({ launch }) => {
  const app = await launch({ settings: { lowPerfAsked: false } })
  const { page } = app
  // Simulate no hardware decoding (equivalent to ADITOR_E2E_NOHWDECODE=1): override mediaCapabilities.decodingInfo
  // before the next load and reset the "already asked" flag.
  await app.electronApp.context().addInitScript(() => {
    Object.defineProperty(navigator, 'mediaCapabilities', {
      value: { decodingInfo: async () => ({ supported: true, smooth: false, powerEfficient: false }) },
      configurable: true
    })
  })
  await page.evaluate(() => (window as unknown as { api: Api }).api.settings.set({ lowPerfAsked: false }))
  await page.reload()
  const notice = page.locator('.lowperf-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(i18n.lowPerf.askText)
  await expect.poll(() => readSettings(app).lowPerfAsked).toBe(true) // Record the answer immediately and ask only once.
  await notice.getByRole('button', { name: i18n.lowPerf.enable, exact: true }).click()
  await expect(notice).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-lowperf', /.*/)
  await expect.poll(() => readSettings(app).lowPerfMode).toBe(true)
  await page.reload()
  await expect(page.locator('.app')).toBeVisible()
  await expect(page.locator('.lowperf-notice')).toHaveCount(0)
})
