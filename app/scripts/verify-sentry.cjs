// Deliberately sends one development error and trace through the real application's initialization.
// Uses a fresh profile, fake analysis engine, and disables recording and updates.
const { _electron } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

async function main() {
  const appDir = path.resolve(__dirname, '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-sentry-verification-'))
  const dataDir = path.join(root, 'Aditor')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    version: 1, telemetryEnabled: true, onboardingDone: true, lowPerfAsked: true,
    autoUpdate: false, recording: { autoRecord: false, closeToTray: false }
  }))
  const env = { ...process.env, ADITOR_E2E: '1', ADITOR_APPDATA: root,
    ADITOR_ENGINE: 'fake', ADITOR_E2E_NODE: process.execPath, ADITOR_SENTRY_VERIFY: '1' }
  // Build secrets have no role in a running desktop app.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.SENTRY_AUTH_TOKEN
  delete env.SENTRY_UPLOAD_SOURCEMAPS
  const app = await _electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 })
  try {
    const page = await app.firstWindow({ timeout: 30_000 })
    await page.waitForSelector('#root > *')
    const reportFile = path.join(dataDir, 'sentry-verification.json')
    const deadline = Date.now() + 30_000
    while (!fs.existsSync(reportFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!fs.existsSync(reportFile)) throw new Error('The application did not finish Sentry verification')
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    if (!report.eventId || !report.flushed) throw new Error('The Sentry transport did not flush successfully')
    console.log(JSON.stringify(report))
    if (!report.debugImageCount) throw new Error('The event has no source-map Debug ID; build with SENTRY_UPLOAD_SOURCEMAPS=1 first')
    await page.evaluate(async () => { await window.api.settings.set({ telemetryEnabled: false }) })
    if (await page.evaluate(() => window.api.telemetry.enabled())) throw new Error('Consent withdrawal failed')
    console.log('Verified immediate consent withdrawal in the isolated profile.')
  } finally {
    await app.close()
    // Keep this diagnostic-only profile for inspection. Never delete or edit the real user profile.
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
