// Storage-root creation and suggested values: pure filesystem logic with no Electron dependency, so it can be unit tested.
// Structure is defined in shared/storage.ts: <root>/Recordings, <root>/Exports/Merged, <root>/Exports/Clips.
import fs from 'fs'
import path from 'path'
import {
  EXPORTS_DIRNAME,
  EXPORT_CLIPS_DIRNAME,
  EXPORT_MERGED_DIRNAME,
  RECORDINGS_DIRNAME
} from '../shared/storage'
import { isSafeLocalDirPath } from './safe-path'

export interface PreparedStorageRoot {
  root: string
  recordingsDir: string
  exportsDir: string
}

/**
 * Validate and create a storage location: it must be a local absolute path; create the root and all subdirectories, then verify writability with a temporary file.
 * Throw an error that can be displayed directly in the Settings row on failure.
 */
export function prepareStorageRoot(input: unknown, fsApi: typeof fs = fs): PreparedStorageRoot {
  if (!isSafeLocalDirPath(input)) {
    throw new Error(`儲存位置必須是本機絕對路徑：${typeof input === 'string' ? input : String(input)}`)
  }
  const root = path.resolve(input)
  const recordingsDir = path.join(root, RECORDINGS_DIRNAME)
  const exportsDir = path.join(root, EXPORTS_DIRNAME)
  try {
    for (const dir of [
      root,
      recordingsDir,
      exportsDir,
      path.join(exportsDir, EXPORT_MERGED_DIRNAME),
      path.join(exportsDir, EXPORT_CLIPS_DIRNAME)
    ]) {
      fsApi.mkdirSync(dir, { recursive: true })
    }
    const probe = path.join(root, `.aditor-write-test-${process.pid}`)
    fsApi.writeFileSync(probe, '')
    fsApi.rmSync(probe, { force: true })
  } catch (err) {
    throw new Error(`無法建立或寫入儲存位置：${root}（${(err as Error).message}）`)
  }
  return { root, recordingsDir, exportsDir }
}

const sameName = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

export interface StorageRootSuggestInput {
  recordingOutputDir: string | null
  defaultOutDir: string | null
  videosDir: string
}

/** Suggested storage root: reuse the parent of existing Recordings/Exports folders; otherwise use Videos\Aditor. */
export function suggestStorageRoot({ recordingOutputDir, defaultOutDir, videosDir }: StorageRootSuggestInput): string {
  if (recordingOutputDir && sameName(path.basename(recordingOutputDir), RECORDINGS_DIRNAME)) {
    return path.dirname(recordingOutputDir)
  }
  if (defaultOutDir && sameName(path.basename(defaultOutDir), EXPORTS_DIRNAME)) {
    return path.dirname(defaultOutDir)
  }
  return path.join(videosDir, 'Aditor')
}
