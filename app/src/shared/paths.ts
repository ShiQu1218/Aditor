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
