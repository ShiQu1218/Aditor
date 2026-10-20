import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/** Storage where sync clients or network latency can move, lock, or delay recording segments. */
export type StorageKind = 'cloud' | 'network'

export interface VolumeInfo { driveType: number; volumeName: string; providerName: string }

/** Win32_LogicalDisk.DriveType for a mapped network drive. */
const DRIVE_TYPE_NETWORK = 4
const CLOUD_VOLUME_LABEL = /google\s*drive|onedrive|dropbox|icloud/i
const VOLUME_QUERY_TIMEOUT_MS = 10000
const DEFAULT_CLOUD_FOLDERS = ['Dropbox', 'iCloudDrive', 'Google Drive', 'Box']
const ONEDRIVE_VARIABLES = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']

export function cloudSyncRoots(env: NodeJS.ProcessEnv, home: string, extra: readonly string[] = []): string[] {
  const fromEnv = ONEDRIVE_VARIABLES.map((name) => env[name]).filter((value): value is string => !!value)
  return [...new Set([...fromEnv, ...extra, ...DEFAULT_CLOUD_FOLDERS.map((name) => path.join(home, name))])]
}

function isInside(dir: string, root: string): boolean {
  const relative = path.relative(root.toLowerCase(), dir.toLowerCase())
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

export function classifyStorage(dir: string, roots: readonly string[], volume: VolumeInfo | null): StorageKind | null {
  const resolved = path.resolve(dir)
  if (roots.some((root) => isInside(resolved, path.resolve(root)))) return 'cloud'
  if (!volume) return null
  if (volume.driveType === DRIVE_TYPE_NETWORK) return 'network'
  return CLOUD_VOLUME_LABEL.test(volume.volumeName) ? 'cloud' : null
}

export function parseVolumeInfo(output: string): VolumeInfo | null {
  let value: unknown
  try { value = JSON.parse(output) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.DriveType)) return null
  const text = (field: unknown): string => (typeof field === 'string' ? field : '')
  return { driveType: Number(record.DriveType), volumeName: text(record.VolumeName), providerName: text(record.ProviderName) }
}

function queryVolume(dir: string): Promise<VolumeInfo | null> {
  const drive = /^([A-Za-z]):/.exec(path.resolve(dir))?.[1]
  if (process.platform !== 'win32' || !drive) return Promise.resolve(null)
  const script = `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive.toUpperCase()}:'" | ` +
    'Select-Object DriveType,VolumeName,ProviderName | ConvertTo-Json -Compress'
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: VOLUME_QUERY_TIMEOUT_MS }, (error, stdout) => {
        if (error) reject(error)
        else resolve(parseVolumeInfo(stdout.trim()))
      })
  })
}

/** Dropbox stores its sync folders in info.json; a missing or unreadable file means Dropbox is not installed. */
async function dropboxRoots(env: NodeJS.ProcessEnv): Promise<string[]> {
  const files = [env.APPDATA, env.LOCALAPPDATA].filter((value): value is string => !!value)
    .map((base) => path.join(base, 'Dropbox', 'info.json'))
  const roots: string[] = []
  for (const file of files) {
    try {
      const info = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, { path?: unknown } | undefined>
      for (const account of Object.values(info)) if (typeof account?.path === 'string') roots.push(account.path)
    } catch { /* Dropbox is not installed for this location. */ }
  }
  return roots
}

export async function probeStorageKind(dir: string): Promise<StorageKind | null> {
  const roots = cloudSyncRoots(process.env, os.homedir(), await dropboxRoots(process.env))
  return classifyStorage(dir, roots, await queryVolume(dir))
}
