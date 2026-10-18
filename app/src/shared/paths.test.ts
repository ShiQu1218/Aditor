import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { apexrecCommand } from './paths'

describe('apexrecCommand', () => {
  const root = path.resolve(__dirname, '../../..')
  const resources = process as unknown as { resourcesPath?: string }
  const originalResources = resources.resourcesPath

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (originalResources === undefined) delete resources.resourcesPath
    else resources.resourcesPath = originalResources
  })

  it('uses the release recorder and prepends the development DLL directory', () => {
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.stubEnv('PATH', 'existing-tools')
    expect(apexrecCommand(false)).toEqual({
      command: path.join(root, 'recorder/target/release/apexrec.exe'), args: [],
      env: { PATH: `${path.join(root, 'build/ffmpeg/bin')}${path.delimiter}existing-tools` }
    })
    expect(exists).toHaveBeenCalledWith(path.join(root, 'recorder/target/release/apexrec.exe'))
  })

  it('falls back to debug without requiring a recorder build in the worktree', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    expect(apexrecCommand(false).command).toBe(path.join(root, 'recorder/target/debug/apexrec.exe'))
  })

  it('uses the packaged FFmpeg DLL directory without probing local executables', () => {
    resources.resourcesPath = path.resolve('installed/resources')
    const exists = vi.spyOn(fs, 'existsSync')
    expect(apexrecCommand(true)).toEqual({
      command: path.join(resources.resourcesPath, 'ffmpeg/bin/apexrec.exe'), args: []
    })
    expect(exists).not.toHaveBeenCalled()
  })

  it('ships all three generated 32px tray icons outside the asar archive', () => {
    const config = fs.readFileSync(path.join(root, 'app/electron-builder.yml'), 'utf8')
    expect(config).toMatch(/from: resources\s+to: resources\s+filter:\s+- tray-\*\.png/)
    for (const state of ['idle', 'recording', 'error']) {
      const png = fs.readFileSync(path.join(root, `app/resources/tray-${state}.png`))
      expect(png.subarray(1, 4).toString()).toBe('PNG')
      expect(png.readUInt32BE(16)).toBe(32)
      expect(png.readUInt32BE(20)).toBe(32)
    }
  })
})
