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
    const exe = path.join(resPath, 'engine', 'aditor', 'aditor.exe')
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
    args: ['-m', 'aditor', 'ipc'],
    env: {
      PYTHONPATH: path.join(root, 'engine')
    }
  }
}

/** 對局場景範本（`templates/scene`，live 引擎 `--scene-dir`）；位置規則同 `profileDir`。 */
export function sceneDir(isPackaged: boolean): string {
  return path.join(path.dirname(profileDir(isPackaged)), 'scene')
}

/**
 * live 引擎（第 3 期，`aditor live …`）的啟動方式：與 `engineCommand` 相同的執行檔，子指令改為 `live`。
 * 呼叫端再附加 `--shm`／`--profile-dir`／`--scene-dir`。
 */
export function liveEngineCommand(isPackaged: boolean): {
  command: string
  args: string[]
  env?: Record<string, string>
} {
  const base = engineCommand(isPackaged)
  return { ...base, args: [...base.args.slice(0, -1), 'live'] }
}

/** aditorrec 與 FFmpeg DLL 同層；開發時優先使用 release，尚未建置時改找 debug。 */
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

