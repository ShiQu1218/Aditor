import path from 'path'
import os from 'os'

export function appDataDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(base, 'ApexHighlighter')
}

export function cacheDir(): string {
  return path.join(appDataDir(), 'cache')
}

export function proxyDir(): string {
  return path.join(appDataDir(), 'proxy')
}

export function codecsDir(): string {
  return path.join(appDataDir(), 'codecs')
}

/** 分析範本目錄（`profile_dir`）：開發＝repo 的 `templates/icons`（與語言無關的單一設定檔），打包＝resources 下同名目錄。 */
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
    const exe = path.join(resPath, 'engine', 'apexhl', 'apexhl.exe')
    return {
      command: exe,
      args: ['ipc']
    }
  }

  // Development mode: look for engine/.venv/Scripts/python.exe relative to repo root
  const root = path.resolve(__dirname, '../../..')
  const pythonExe = path.join(root, 'engine', '.venv', 'Scripts', 'python.exe')
  return {
    command: pythonExe,
    args: ['-m', 'apexhl', 'ipc'],
    env: {
      PYTHONPATH: path.join(root, 'engine')
    }
  }
}

/** 隨安裝包附帶的第三方授權清單：打包＝resources 根目錄，開發＝repo 根目錄。 */
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
  if (process.env.APEXHL_FFMPEG) {
    return process.env.APEXHL_FFMPEG
  }
  if (isPackaged) {
    const resPath = (process as unknown as { resourcesPath?: string }).resourcesPath || path.join(__dirname, '..', '..')
    const exe = path.join(resPath, 'ffmpeg', 'bin', 'ffmpeg.exe')
    return exe
  }
  return 'ffmpeg'
}

