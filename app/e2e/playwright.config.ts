import { defineConfig } from '@playwright/test'
import os from 'os'
import path from 'path'

// Developers can run `npm --prefix app run test:e2e` manually (the script builds first). CI does not require it.
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Keep screenshots and traces in a temporary directory; do not check them in.
  outputDir: path.join(os.tmpdir(), 'aditor-e2e-results'),
  globalSetup: require.resolve('./helpers/globalSetup'),
  globalTeardown: require.resolve('./helpers/globalTeardown')
})
