import fs from 'fs'
import os from 'os'
import path from 'path'
import { makeFixtures } from './makeFixtures'

export const FIXTURE_FILE = path.join(os.tmpdir(), 'aditor-e2e-fixtures.json')

export default async function globalSetup(): Promise<void> {
  const set = makeFixtures()
  if (!set.ok) console.log(`[e2e] ${set.reason}`)
  fs.writeFileSync(FIXTURE_FILE, JSON.stringify(set), 'utf-8')
}
