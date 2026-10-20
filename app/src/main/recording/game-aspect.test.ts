import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { apexVideoConfigPath, parseVideoConfig, readGameAspect, readGameAspectSync } from './game-aspect'

const config = (width: string, height: string, extra = ''): string =>
  `"VideoConfig"\n{\n\t"setting.cl_gib_allow"\t\t"0"\n\t"setting.defaultres"\t\t"${width}"\n` +
  `\t"setting.defaultresheight"\t\t"${height}"\n${extra}}\n`

describe('Apex render aspect', () => {
  it.each([['1920', '1440'], ['1280', '1024'], ['1680', '1050'], ['3840', '2160'], ['1366', '768']])(
    'returns the render resolution %sx%s for supported aspects', (width, height) => {
      expect(parseVideoConfig(config(width, height))).toBe(`${width}x${height}`)
    })

  it.each([['2560', '1080'], ['1000', '1000'], ['0', '1080'], ['abc', '1080']])('rejects unsupported %sx%s', (width, height) => {
    expect(parseVideoConfig(config(width, height))).toBeNull()
  })

  it('ignores NUL bytes and returns null when the keys are missing', () => {
    expect(parseVideoConfig(config('1920', '1440').replace('defaultres"', 'defaultres"\0'))).toBe('1920x1440')
    expect(parseVideoConfig('"VideoConfig"\n{\n}\n')).toBeNull()
  })

  it('reads the config under Saved Games and treats a missing file as unknown', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-aspect-'))
    expect(await readGameAspect(home)).toBeNull()
    const file = apexVideoConfigPath(home)
    expect(file).toBe(path.join(home, 'Saved Games', 'Respawn', 'Apex', 'local', 'videoconfig.txt'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, config('1920', '1440'))
    expect(await readGameAspect(home)).toBe('1920x1440')
  })
})

describe('Apex render aspect (synchronous)', () => {
  it('matches the asynchronous reader', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-aspect-sync-'))
    expect(readGameAspectSync(home)).toBeNull()
    fs.mkdirSync(path.dirname(apexVideoConfigPath(home)), { recursive: true })
    fs.writeFileSync(apexVideoConfigPath(home), config('1280', '1024'))
    expect(readGameAspectSync(home)).toBe('1280x1024')
  })
})
