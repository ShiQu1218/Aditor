import fs from 'fs'
import type { RecordingSettings } from '../../shared/recording'

export async function diskFreeBytes(dir: string): Promise<number> {
  const stat = await fs.promises.statfs(dir, { bigint: true })
  return Number(stat.bavail * stat.bsize)
}

export function diskLevel(bytes: number, settings: RecordingSettings): 'stop' | 'warn' | 'ok' {
  const gb = bytes / 1024 ** 3
  if (gb < settings.diskStopGb) return 'stop'
  if (gb < settings.diskWarnGb) return 'warn'
  return 'ok'
}
