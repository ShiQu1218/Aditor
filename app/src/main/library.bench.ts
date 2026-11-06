import { afterAll, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Library, type LibraryEntry } from './library'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-library-bench-'))
const file = path.join(dir, 'library.json')
const entries: LibraryEntry[] = Array.from({ length: 500 }, (_, i) => ({
  path: path.join(dir, `video-${i}.mp4`),
  addedAt: i,
  favorite: false,
  status: 'pending',
  progress: 0,
  hl: 3
}))
fs.writeFileSync(file, JSON.stringify(entries))
const library = new Library(file)

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

test('Library with 500 entries', { timeout: 120_000 }, async ({ bench }) => {
  const result = await bench.compare(
    bench('500 unchanged pending updates', () => {
      for (const entry of entries) library.update(entry.path, { status: 'pending', progress: 0 })
    }),
    bench('100 unchanged highlight updates', () => {
      for (let i = 0; i < 100; i++) library.update(entries[i].path, { hl: 3 })
    }),
    bench('one changed update', () => {
      library.update(entries[499].path, { favorite: !library.get(entries[499].path)!.favorite })
    }),
    { time: 100, iterations: 5, warmup: false }
  )
  for (const name of ['500 unchanged pending updates', '100 unchanged highlight updates', 'one changed update'] as const) {
    console.log(`${name}: median ${result.get(name).latency.p50} ms`)
  }
})
