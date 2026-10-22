import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import ts from 'typescript'
import { expect, test } from 'vitest'

test('native Node import loads the real CommonJS updater and keeps install-on-quit disabled', () => {
  // Preserve native import(): Vite's module interop would hide the production regression.
  const source = ts.transpileModule(readFileSync(resolve(__dirname, 'updater.ts'), 'utf-8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: resolve(__dirname, '../..'),
    windowsHide: true,
    encoding: 'utf-8',
    timeout: 10_000,
    input: `
      import { createRequire } from 'node:module';
      import assert from 'node:assert/strict';
      const require = createRequire(import.meta.url);
      require.cache[require.resolve('electron')] = { exports: { app: { getVersion: () => '0.2.0' } } };
      ${source}
      const updater = await loadAutoUpdater();
      assert.equal(typeof updater.checkForUpdates, 'function');
      assert.equal(typeof updater.quitAndInstall, 'function');
      const service = createAppUpdater({ updater, isEnabled: () => true, notifyDownloaded: () => {}, broadcast: () => {}, requestQuit: () => {} });
      assert.equal(service.status().state, 'idle');
      assert.equal(updater.autoDownload, true);
      assert.equal(updater.autoInstallOnAppQuit, false);
    `
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
})
