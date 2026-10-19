import path from 'path'
import { app } from 'electron'

/**
 * E2E test hooks (enabled only by `ADITOR_E2E=1`; returns null when the environment variable is absent, leaving production behavior unchanged).
 * - `ADITOR_APPDATA`: replace %APPDATA% (and Electron userData) so tests do not touch user data
 * - `ADITOR_ENGINE=fake`: run `app/test/fake-engine.mjs` with node (FAKE_ENGINE_MODE=e2e) instead of the Python engine
 * - `ADITOR_E2E_FAKE_FFMPEG=1`: use `app/test/fake-ffmpeg.mjs` (a real child process for cancellation tests) for exports
 * - `ADITOR_E2E_NODE`: node executable used to run the scripts above (the test runner's process.execPath)
 */
export interface E2EConfig {
  appData: string | null
  fakeEngine: { command: string; args: string[]; env: Record<string, string> } | null
  exportFfmpeg: { bin: string; prefixArgs: string[] } | null
}

/** Always disabled when `isPackaged` is true (installed production build): environment variables cannot change appData, engine, or ffmpeg executables. */
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

/** `app/test` directory in development or packaged builds (out/main → app/test). */
export function e2eTestDir(): string {
  return process.env.ADITOR_E2E_TEST_DIR || path.resolve(__dirname, '../../test')
}

export function currentE2EConfig(): E2EConfig | null {
  let packaged = false
  try {
    packaged = app?.isPackaged === true
  } catch {
    // Treat non-Electron environments (unit tests) as unpackaged.
  }
  return resolveE2EConfig(process.env, e2eTestDir(), packaged)
}
