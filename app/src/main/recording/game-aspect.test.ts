import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { apexVideoConfigPath, parseValorantSettings, parseVideoConfig, readGameAspect } from './game-aspect'

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
    expect(await readGameAspect('apex', home)).toBeNull()
    const file = apexVideoConfigPath(home)
    expect(file).toBe(path.join(home, 'Saved Games', 'Respawn', 'Apex', 'local', 'videoconfig.txt'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, config('1920', '1440'))
    expect(await readGameAspect('apex', home)).toBe('1920x1440')
  })
})

describe('Valorant render aspect', () => {
  const ini = (width: string, height: string): string =>
    `[/Script/ShooterGame.ShooterGameUserSettings]\r\nbShouldLetterbox=False\r\nResolutionSizeX=${width}\r\nResolutionSizeY=${height}\r\n`

  it('accepts only 16:9 resolutions for now', () => {
    expect(parseValorantSettings(ini('2560', '1440'))).toBe('2560x1440')
    expect(parseValorantSettings(ini('1440', '1080'))).toBeNull()
    expect(parseValorantSettings('[x]\r\nFoo=1\r\n')).toBeNull()
  })

  it('reads the most recently written account config and treats a missing folder as unknown', async () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-valorant-'))
    expect(await readGameAspect('valorant', local, local)).toBeNull()
    const write = (account: string, text: string, mtime: number): void => {
      const file = path.join(local, 'VALORANT', 'Saved', 'Config', account, 'Windows', 'GameUserSettings.ini')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
      fs.utimesSync(file, mtime, mtime)
    }
    write('old-account', ini('1440', '1080'), 1_000)
    write('new-account', ini('1920', '1080'), 2_000)
    expect(await readGameAspect('valorant', local, local)).toBe('1920x1080')
  })
})
