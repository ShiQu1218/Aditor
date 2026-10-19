import { defineConfig } from '@playwright/test'
import os from 'os'
import path from 'path'

// 開發者手動執行：`npm --prefix app run test:e2e`（需先 build；script 已包含）。CI 不強制。
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // 截圖與追蹤只放暫存目錄，不入庫
  outputDir: path.join(os.tmpdir(), 'aditor-e2e-results'),
  globalSetup: require.resolve('./helpers/globalSetup'),
  globalTeardown: require.resolve('./helpers/globalTeardown')
})
