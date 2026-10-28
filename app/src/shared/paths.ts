import path from 'path'
import os from 'os'
import fs from 'fs'

export function appDataDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(base, 'Aditor')
}

export function cacheDir(): string {
  return path.join(appDataDir(), 'cache')
}

/**
 * Electron userData. Default = %APPDATA%\aditor, where Chromium's `Cache` is (case-insensitively) the same as the analysis cache `cacheDir()` on Windows.
 * Chromium can delete analysis results while rebuilding its HTTP cache, so the directories must be separated.
 */
export function chromiumUserDataDir(): string {
  return path.join(appDataDir(), 'electron-userdata')
}

export function proxyDir(): string {
  return path.join(appDataDir(), 'proxy')
}

export function codecsDir(): string {
  return path.join(appDataDir(), 'codecs')
}

/** Analysis profile directory (`profile_dir`): `templates/icons` in the repo during development (single language-independent profile), same-named directory under resources when packaged. */
export function profileDir(isPackaged: boolean): string {
  const root = isPackaged
    ? (process as unknown as { resourcesPath?: string }).resourcesPath || path.join(__dirname, '..', '..')
    : path.resolve(__dirname, '../../..')
  return path.join(root, 'templates', 'icons')
}

export function engineCommand(isPackaged: boolean): {
  command: string
  args: string[]
  env?: Record<string, string>
} {
  if (isPackaged) {
    const resPath = (process as unknown as { resourcesPath?: string }).resourcesPath || path.join(__dirname, '..', '..')
    const exe = path.join(resPath, 'engine', 'aditor', 'aditor.exe')
    return {
      command: exe,
      args: ['ipc'],
      env: {
        ADITOR_FFMPEG: process.env.ADITOR_FFMPEG || path.join(resPath, 'ffmpeg', 'bin', 'ffmpeg.exe')
      }
    }
  }

  const root = path.resolve(__dirname, '../../..')
  const release = path.join(root, 'engine', 'target', 'release', 'aditor.exe')
  return {
    command: fs.existsSync(release) ? release : path.join(root, 'engine', 'target', 'debug', 'aditor.exe'),
    args: ['ipc']
  }
}

/** Match-scene templates (`templates/scene`, live engine `--scene-dir`); location follows the same rule as `profileDir`. */
export function sceneDir(isPackaged: boolean): string {
  return path.join(path.dirname(profileDir(isPackaged)), 'scene')
}

/**
 * Launch the live engine (Phase 3, `aditor live …`) with the same executable as `engineCommand`, but use the `live` subcommand.
 * The caller appends `--shm`/`--profile-dir`/`--scene-dir`.
 */
export function liveEngineCommand(isPackaged: boolean): {
  command: string
  args: string[]
  env?: Record<string, string>
} {
  const base = engineCommand(isPackaged)
  return { ...base, args: [...base.args.slice(0, -1), 'live'] }
}

/** aditorrec is alongside FFmpeg DLLs; prefer release during development, falling back to debug when not built. */
export function aditorrecCommand(isPackaged: boolean): {
  command: string
  args: string[]
  env?: Record<string, string>
} {
  if (isPackaged) {
    const root = (process as unknown as { resourcesPath?: string }).resourcesPath || path.join(__dirname, '..', '..')
    return { command: path.join(root, 'ffmpeg', 'bin', 'aditorrec.exe'), args: [] }
  }
  const root = path.resolve(__dirname, '../../..')
  const release = path.join(root, 'recorder', 'target', 'release', 'aditorrec.exe')
  return {
    command: fs.existsSync(release) ? release : path.join(root, 'recorder', 'target', 'debug', 'aditorrec.exe'),
    args: [],
    env: { PATH: `${path.join(root, 'build', 'ffmpeg', 'bin')}${path.delimiter}${process.env.PATH || ''}` }
  }
}

/** OBS graphics-hook files (`hook_dir`): `build/obs-hook` in the repo during development and `obs-hook` under resources when packaged. */
export function obsHookDir(isPackaged: boolean): string {
  const root = isPackaged
    ? (process as unknown as { resourcesPath?: string }).resourcesPath || path.join(__dirname, '..', '..')
    : path.join(path.resolve(__dirname, '../../..'), 'build')
  return path.join(root, 'obs-hook')
}

/** Third-party notices bundled with the installer: resources root when packaged, repo root in development. */
export function noticesFile(isPackaged: boolean): string {
  return bundledDocFile(isPackaged, 'THIRD_PARTY_NOTICES.md')
}

export function licenseFile(isPackaged: boolean): string {
  return bundledDocFile(isPackaged, 'LICENSE')
}

function bundledDocFile(isPackaged: boolean, name: string): string {
  if (isPackaged) {
    const resPath = (process as unknown as { resourcesPath?: string }).resourcesPath || path.join(__dirname, '..', '..')
    return path.join(resPath, name)
  }
  return path.resolve(__dirname, '../../..', name)
}

export function ffmpegExecutable(isPackaged: boolean): string {
  if (process.env.ADITOR_FFMPEG) {
    return process.env.ADITOR_FFMPEG
  }
  if (isPackaged) {
    const resPath = (process as unknown as { resourcesPath?: string }).resourcesPath || path.join(__dirname, '..', '..')
    const exe = path.join(resPath, 'ffmpeg', 'bin', 'ffmpeg.exe')
    return exe
  }
  return 'ffmpeg'
}

