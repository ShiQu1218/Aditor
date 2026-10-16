import fs from 'fs'
import { FIXTURE_FILE } from './globalSetup'

export default async function globalTeardown(): Promise<void> {
  try {
    const set = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf-8')) as { dir: string }
    fs.rmSync(set.dir, { recursive: true, force: true })
  } catch {
    /* 已清掉 */
  }
  fs.rmSync(FIXTURE_FILE, { force: true })
}
