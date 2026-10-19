import path from 'path'
import { app } from 'electron'

/**
 * E2E 測試掛鉤（`ADITOR_E2E=1` 才生效；環境變數缺席時回傳 null，正式行為完全不變）。
 * - `ADITOR_APPDATA`：取代 %APPDATA%（與 Electron userData），測試不碰使用者資料
 * - `ADITOR_ENGINE=fake`：以 node 執行 `app/test/fake-engine.mjs`（FAKE_ENGINE_MODE=e2e）取代 Python 引擎
 * - `ADITOR_E2E_FAKE_FFMPEG=1`：匯出改用 `app/test/fake-ffmpeg.mjs`（真實子程序，供取消測試）
 * - `ADITOR_E2E_NODE`：執行上述腳本的 node 可執行檔（測試執行器的 process.execPath）
 */
export interface E2EConfig {
  appData: string | null
  fakeEngine: { command: string; args: string[]; env: Record<string, string> } | null
  exportFfmpeg: { bin: string; prefixArgs: string[] } | null
}

/** `isPackaged` 為 true（正式安裝版）時一律關閉：環境變數不能改變 appData、引擎或 ffmpeg 的執行檔。 */
export function resolveE2EConfig(env: NodeJS.ProcessEnv, testDir: string, isPackaged: boolean): E2EConfig | null {
  if (isPackaged) return null
  if (env.ADITOR_E2E !== '1') return null
  const node = env.ADITOR_E2E_NODE || 'node'
  return {
    appData: env.ADITOR_APPDATA ? path.resolve(env.ADITOR_APPDATA) : null,
    fakeEngine:
      env.ADITOR_ENGINE === 'fake'
        ? { command: node, args: [path.join(testDir, 'fake-engine.mjs')], env: { FAKE_ENGINE_MODE: 'e2e' } }
        : null,
    exportFfmpeg: env.ADITOR_E2E_FAKE_FFMPEG === '1' ? { bin: node, prefixArgs: [path.join(testDir, 'fake-ffmpeg.mjs')] } : null
  }
}

/** 開發／打包後 `app/test` 目錄（out/main → app/test）。 */
export function e2eTestDir(): string {
  return process.env.ADITOR_E2E_TEST_DIR || path.resolve(__dirname, '../../test')
}

export function currentE2EConfig(): E2EConfig | null {
  let packaged = false
  try {
    packaged = app?.isPackaged === true
  } catch {
    // 非 Electron 環境（單元測試）視為未打包
  }
  return resolveE2EConfig(process.env, e2eTestDir(), packaged)
}
