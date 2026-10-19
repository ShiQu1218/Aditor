import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findFfmpeg } from './makeFixtures'

const APP_DIR = path.resolve(__dirname, '../..')

export interface LaunchOpts {
  /** 重啟：沿用既有 appData 根目錄（settings、library、projects、cache 都在裡面） */
  root?: string
  /** 傳入既有 root 時，是否由 fixture 在測試結束刪除（預設：只有自己建立的才刪） */
  ownRoot?: boolean
  /** 預先寫入 settings.json 的欄位（與測試預設合併） */
  settings?: Record<string, unknown>
  /** 額外環境變數（例如 FAKE_ENGINE_EVENTS、FAKE_ENGINE_GATE_DIR） */
  env?: Record<string, string>
  /** 匯出改用假 ffmpeg（app/test/fake-ffmpeg.mjs，真實子程序） */
  fakeExport?: boolean
  /** 視窗內容大小 */
  size?: { width: number; height: number }
}

/** 測試預設設定：已問過低效能（不彈通知）、事件前後 1 秒、AI 剪輯 gap=5 讓合成影片產生多段建議。 */
export const TEST_SETTINGS = {
  onboardingDone: true,
  version: 1,
  lowPerfAsked: true,
  before: 1,
  after: 1,
  autoclip: { n: 1, gap: 5, before: 1, after: 1, max_len: 15 }
}

export interface AppHandle {
  electronApp: ElectronApplication
  page: Page
  /** appData 根（相當於 %APPDATA%）；Aditor 資料夾在其下 */
  root: string
  dataDir: string
  settingsPath: string
  projectsDir: string
  cacheDir: string
  pid: number
  /** 此 appData 根是本次啟動建立的（測試結束由 fixture 刪除） */
  ownsRoot: boolean
  /** 透過視窗 close（走 flush 握手）正常結束並等待程序結束 */
  closeWindow(): Promise<void>
  /** 結束並清理（寫入 root 的資料保留給 relaunch；ownsRoot 時一併刪除） */
  dispose(): Promise<void>
}

const live = new Set<number>()

function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已結束 */
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function launchApp(opts: LaunchOpts = {}): Promise<AppHandle> {
  const ownsRoot = opts.ownRoot ?? !opts.root
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-app-'))
  const dataDir = path.join(root, 'Aditor')
  const settingsPath = path.join(dataDir, 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ ...TEST_SETTINGS, ...opts.settings }), 'utf-8')
  }
  const ffmpeg = findFfmpeg()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  Object.assign(env, {
    ADITOR_E2E: '1',
    ADITOR_APPDATA: root,
    ADITOR_ENGINE: 'fake',
    ADITOR_E2E_NODE: process.execPath,
    FAKE_ENGINE_STEP_MS: '25',
    ...(ffmpeg ? { ADITOR_FFMPEG: ffmpeg } : {}),
    ...(opts.fakeExport ? { ADITOR_E2E_FAKE_FFMPEG: '1' } : {}),
    ...opts.env
  })
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron')) as string
  const electronApp = await electron.launch({ executablePath: electronPath, args: [APP_DIR], env, cwd: APP_DIR })
  const pid = electronApp.process().pid as number
  live.add(pid)
  const page = await electronApp.firstWindow()
  await page.waitForSelector('.app', { timeout: 30_000 })
  const size = opts.size ?? { width: 1440, height: 1000 } // 預設較高，專案軌不會因 ≤800px 自動收合
  await electronApp.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), size)

  const waitExit = async (ms: number): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (!isAlive(pid)) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return !isAlive(pid)
  }

  const handle: AppHandle = {
    electronApp,
    page,
    root,
    dataDir,
    settingsPath,
    projectsDir: path.join(dataDir, 'projects'),
    cacheDir: path.join(dataDir, 'cache'),
    pid,
    ownsRoot,
    async closeWindow() {
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined)
      if (!(await waitExit(10_000))) killTree(pid)
      live.delete(pid)
    },
    async dispose() {
      if (isAlive(pid)) {
        await electronApp.close().catch(() => undefined)
        if (!(await waitExit(5_000))) killTree(pid)
      }
      live.delete(pid)
    }
  }
  return handle
}

/** 取得 renderer 的 window.api 呼叫（IPC）。 */
export async function api<T>(page: Page, expr: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    ({ expr, arg }) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('api', 'arg', `return (${expr})`)
      return fn((window as unknown as { api: unknown }).api, arg)
    },
    { expr, arg }
  ) as Promise<T>
}
