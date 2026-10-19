import { test as base, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AppHandle, LaunchOpts, launchApp } from './launch'
import type { FixtureSet } from './makeFixtures'
import { FIXTURE_FILE } from './globalSetup'

export const SHOTS = path.join(os.tmpdir(), 'aditor-e2e-shots')

interface Fixtures {
  /** 啟動（可多次；測試結束時全部關閉並刪除暫存 appData） */
  launch: (opts?: LaunchOpts) => Promise<AppHandle>
  /** 合成影片；找不到 ffmpeg 時整個案例 skip 並印出原因 */
  videos: FixtureSet
}

export const test = base.extend<Fixtures>({
  videos: async ({}, use, testInfo) => {
    const set = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf-8')) as FixtureSet
    if (!set.ok) {
      console.log(`[e2e skip] ${testInfo.title}: ${set.reason}`)
      testInfo.skip(true, set.reason)
    }
    await use(set)
  },
  launch: async ({}, use) => {
    const apps: AppHandle[] = []
    await use(async (opts) => {
      const a = await launchApp(opts)
      apps.push(a)
      return a
    })
    for (const a of [...apps].reverse()) await a.dispose()
    for (const a of apps) if (a.ownsRoot) fs.rmSync(a.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

export { expect }

export async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => undefined)
}

/** 影片庫卡片（以檔名主體定位）。 */
export const card = (page: Page, title: string) => page.locator('.vcard', { hasText: title })

/** 經 IPC 匯入並等到每支影片分析完成（卡片出現事件徽章區）。 */
export async function importAndAnalyze(page: Page, paths: string[], titles: string[]): Promise<void> {
  await page.evaluate((p) => (window as unknown as { api: { library: { add: (x: string[]) => Promise<unknown> } } }).api.library.add(p), paths)
  for (const t of titles) await expect(card(page, t).locator('.vcard-counts')).toBeVisible({ timeout: 60_000 })
}

export async function openStudio(page: Page, title: string): Promise<void> {
  await card(page, title).locator('.vcard-open').click()
  await expect(page.locator('.studio-aside')).toBeVisible()
  await expect(page.locator('.hl-card').first()).toBeVisible()
}

export const playheadVideo = (page: Page) => page.locator('video')
export async function videoTime(page: Page): Promise<number> {
  return page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime)
}

export function toastLocator(page: Page, text: string | RegExp) {
  return page.locator('.toast', { hasText: text })
}

export interface StoredProjectFile {
  id: string
  name: string
  items: Array<{ id: string; source: string; start: number; end: number }>
}

/** 等待磁碟上的專案檔存在且片段數符合；回傳其內容（id 取自檔名）。 */
export async function waitProjectFile(app: AppHandle, items: number): Promise<StoredProjectFile> {
  let found: StoredProjectFile | null = null
  await expect
    .poll(
      () => {
        try {
          for (const n of fs.readdirSync(app.projectsDir)) {
            if (!/^[A-Za-z0-9_-]+\.json$/.test(n)) continue
            const doc = JSON.parse(fs.readFileSync(path.join(app.projectsDir, n), 'utf-8'))
            if (Array.isArray(doc.items) && doc.items.length === items) {
              found = { ...doc, id: n.replace(/\.json$/, '') }
              return true
            }
          }
        } catch {
          /* 寫入中或尚未建立 */
        }
        return false
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  return found!
}

export function readSettings(app: AppHandle): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(app.settingsPath, 'utf-8'))
}
