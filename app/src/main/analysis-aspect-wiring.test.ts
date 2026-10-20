import fs from 'fs'
import path from 'path'
import { expect, it } from 'vitest'

it('does not inject the current Apex config into offline IPC or queued analysis', () => {
  for (const file of ['index.ts', 'queue.ts']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
    expect(source).not.toMatch(/readGameAspectSync|gameAspectArg|getGameAspect/)
  }
})
