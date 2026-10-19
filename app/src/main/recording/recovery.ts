import fs from 'fs'
import path from 'path'
import { isSafeLocalDirPath } from '../safe-path'
import { ObsRecoveryPending } from './obs-finalize'
import { finalizeSession } from './finalize'
import type { RecordingDeps } from './index'
import { tr } from '../../shared/locale'

/** 啟動掃描與新錄影串行，避免把目前仍在寫入的工作當作崩潰殘留。 */
export async function recoverSessions(
  deps: RecordingDeps,
  finalized: (paths: string[]) => void,
  failed: (error: unknown) => void,
  cancelled: () => boolean = () => false
): Promise<void> {
  const folders = [deps.getSettings().outputDir, ...deps.getWatchFolders(), deps.defaultOutputDir]
    .filter((dir): dir is string => isSafeLocalDirPath(dir))
  const unique = new Map(folders.map((dir) => [process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir), dir]))
  for (const dir of unique.values()) {
    if (cancelled()) return
    const root = path.join(dir, '.sessions')
    try {
      if ((await fs.promises.lstat(root)).isSymbolicLink()) throw new Error(tr('不支援連結的錄影工作目錄：{root}', { root }))
      const entries = await fs.promises.readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (cancelled()) return
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        try {
          const paths = await finalizeSession(path.join(root, entry.name), deps)
          if (paths.length) finalized(paths)
        } catch (error) { if (!(error instanceof ObsRecoveryPending)) failed(error) }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed(error)
    }
  }
}
