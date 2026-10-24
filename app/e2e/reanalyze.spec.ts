import fs from 'fs'
import os from 'os'
import path from 'path'
import { test, expect, importAndAnalyze, card } from './helpers/test'
import { i18n } from '../src/renderer/i18n'

interface CacheDoc {
  analysis: { status: string }
  events: unknown[]
}

type QueueApi = { queue: { enqueue: (p: string, force?: boolean) => Promise<unknown> } }

test('card menu "Re-analyze" bypasses a valid analysis cache while a plain enqueue reuses it', async ({ launch, videos }) => {
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-gate-'))
  try {
    const app = await launch({ env: { FAKE_ENGINE_GATE_DIR: gate } })
    const { page } = app
    const video = videos.videos[0]
    await importAndAnalyze(page, [video.path], [video.title])

    const [cacheName] = fs.readdirSync(app.cacheDir).filter((n) => /^[0-9a-f]{40}\.json$/.test(n))
    expect(cacheName).toBeTruthy()
    const cacheFile = path.join(app.cacheDir, cacheName)
    const readCache = (): CacheDoc => JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
    const cacheMtime = (): number => fs.statSync(cacheFile).mtimeMs
    await expect.poll(() => readCache().analysis.status).toBe('done')
    const firstMtime = cacheMtime()
    const eventCount = readCache().events.length
    expect(eventCount).toBeGreaterThan(0)

    // A gate file makes the fake engine pause midway through a real analysis. A cache hit returns before that point.
    fs.writeFileSync(path.join(gate, 'hold'), '')
    const c = card(page, video.title)

    // Control: a plain enqueue (what the retry button does) must reuse the valid cache, so it neither reaches the gate
    // (the card stays done instead of progress getting stuck) nor rewrites the cache file.
    await page.evaluate((p) => (window as unknown as { api: QueueApi }).api.queue.enqueue(p), video.path)
    await expect(c.locator('.vcard-counts')).toBeVisible()
    await page.waitForTimeout(700) // Longer than a cache hit takes; a forced run would still be held at the gate.
    await expect(c.locator('.vcard-progress')).toHaveCount(0)
    expect(cacheMtime()).toBe(firstMtime)

    // Re-analyze through the real card menu: the engine must bypass the still-valid cache and run again, so it reaches
    // the gate and the card stays in the analyzing state until the gate is released.
    await c.locator('.vcard-more').click()
    await page.locator('.vcard-menu').getByRole('menuitem', { name: i18n.library.card.reanalyze, exact: true }).click()
    await expect(c.locator('.vcard-progress')).toBeVisible()
    await page.waitForTimeout(700)
    await expect(c.locator('.vcard-progress')).toBeVisible() // A cache hit could not stay analyzing this long.

    fs.rmSync(path.join(gate, 'hold'), { force: true })
    await expect(c.locator('.vcard-progress')).toHaveCount(0, { timeout: 60_000 })
    await expect(c.locator('.vcard-counts')).toBeVisible()
    await expect.poll(() => readCache().analysis.status).toBe('done')
    // The engine wrote the cache again; a cache hit would have left the file untouched.
    expect(cacheMtime()).toBeGreaterThan(firstMtime)
    expect(readCache().events.length).toBe(eventCount)
  } finally {
    fs.rmSync(path.join(gate, 'hold'), { force: true })
    fs.rmSync(gate, { recursive: true, force: true })
  }
})
