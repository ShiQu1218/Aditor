import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findFfmpeg } from './makeFixtures'

const APP_DIR = path.resolve(__dirname, '../..')

export interface LaunchOpts {
  /** Restart using the existing appData root (settings, library, projects, and cache are stored there). */
  root?: string
  /** When reusing a root, whether the fixture should delete it after tests (defaults to deleting only roots it created). */
  ownRoot?: boolean
  /** Fields to prepopulate in settings.json (merged with test defaults). */
  settings?: Record<string, unknown>
  /** Additional environment variables (for example, FAKE_ENGINE_EVENTS and FAKE_ENGINE_GATE_DIR). */
  env?: Record<string, string>
  /** Use the fake ffmpeg (app/test/fake-ffmpeg.mjs, a real child process) for exports. */
  fakeExport?: boolean
  /** Window content size. */
  size?: { width: number; height: number }
}

/** Test defaults: low-performance prompt already answered (no notification), one second before/after events, and AI clip gap=5 to generate multiple suggestions from synthetic videos. */
export const TEST_SETTINGS = {
  telemetryEnabled: false,
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
  /** appData root (equivalent to %APPDATA%); the Aditor folder is inside it. */
  root: string
  dataDir: string
  settingsPath: string
  projectsDir: string
  cacheDir: string
  pid: number
  /** This appData root was created for this launch (the fixture deletes it after tests). */
  ownsRoot: boolean
  /** Close normally through the window (using the flush handshake) and wait for the process to exit. */
  closeWindow(): Promise<void>
  /** Stop and clean up (preserve data in root for relaunch; delete it when ownsRoot is true). */
  dispose(): Promise<void>
}

const live = new Set<number>()

function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* Already exited. */
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
  const size = opts.size ?? { width: 1440, height: 1000 } // Use a taller default so the project track does not auto-collapse at <=800px.
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

/** Get the renderer's window.api bridge (IPC). */
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
