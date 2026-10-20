import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { aditorrecCommand, cacheDir, chromiumUserDataDir, liveEngineCommand, sceneDir } from './paths'

describe('chromiumUserDataDir', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('Chromium Cache subfolder does not overlap the analysis cache (Windows paths are case-insensitive)', () => {
    vi.stubEnv('APPDATA', path.resolve('roaming'))
    const chromiumCache = path.join(chromiumUserDataDir(), 'Cache').toLowerCase()
    expect(chromiumCache).not.toBe(cacheDir().toLowerCase())
    expect(path.relative(chromiumCache, cacheDir().toLowerCase()).startsWith('..')).toBe(true)
  })
})

describe('liveEngineCommand', () => {
  const root = path.resolve(__dirname, '../../..')
  const resources = process as unknown as { resourcesPath?: string }
  const originalResources = resources.resourcesPath
  afterEach(() => {
    if (originalResources === undefined) delete resources.resourcesPath
    else resources.resourcesPath = originalResources
  })

  it('Development: uses the same venv Python, switches the subcommand to live, and places scene templates in templates/scene', () => {
    expect(liveEngineCommand(false)).toEqual({
      command: path.join(root, 'engine/.venv/Scripts/python.exe'), args: ['-m', 'aditor', 'live'],
      env: { PYTHONPATH: path.join(root, 'engine') }
    })
    expect(sceneDir(false)).toBe(path.join(root, 'templates/scene'))
  })

  it('Packaged: runs aditor.exe live under resources', () => {
    resources.resourcesPath = path.resolve('installed/resources')
    expect(liveEngineCommand(true)).toEqual({ command: path.join(resources.resourcesPath, 'engine/aditor/aditor.exe'), args: ['live'] })
    expect(sceneDir(true)).toBe(path.join(resources.resourcesPath, 'templates/scene'))
  })
})

describe('aditorrecCommand', () => {
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
    expect(aditorrecCommand(false)).toEqual({
      command: path.join(root, 'recorder/target/release/aditorrec.exe'), args: [],
      env: { PATH: `${path.join(root, 'build/ffmpeg/bin')}${path.delimiter}existing-tools` }
    })
    expect(exists).toHaveBeenCalledWith(path.join(root, 'recorder/target/release/aditorrec.exe'))
  })

  it('falls back to debug without requiring a recorder build in the worktree', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    expect(aditorrecCommand(false).command).toBe(path.join(root, 'recorder/target/debug/aditorrec.exe'))
  })

  it('uses the packaged FFmpeg DLL directory without probing local executables', () => {
    resources.resourcesPath = path.resolve('installed/resources')
    const exists = vi.spyOn(fs, 'existsSync')
    expect(aditorrecCommand(true)).toEqual({
      command: path.join(resources.resourcesPath, 'ffmpeg/bin/aditorrec.exe'), args: []
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
