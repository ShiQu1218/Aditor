// 儲存位置（storageRoot）的建立與建議值：純檔案系統邏輯，不依賴 Electron，方便單元測試。
// 結構見 shared/storage.ts：<根>/Recordings、<根>/Exports/Merged、<根>/Exports/Clips。
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
 * 驗證並建立儲存位置：必須是本機絕對路徑；建立根與全部子資料夾，並以暫存檔確認可寫入。
 * 失敗時丟出可直接顯示在設定列的錯誤訊息。
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

/** 建議的儲存根資料夾：沿用既有 Recordings／Exports 的上一層，否則 影片資料夾\Aditor。 */
export function suggestStorageRoot({ recordingOutputDir, defaultOutDir, videosDir }: StorageRootSuggestInput): string {
  if (recordingOutputDir && sameName(path.basename(recordingOutputDir), RECORDINGS_DIRNAME)) {
    return path.dirname(recordingOutputDir)
  }
  if (defaultOutDir && sameName(path.basename(defaultOutDir), EXPORTS_DIRNAME)) {
    return path.dirname(defaultOutDir)
  }
  return path.join(videosDir, 'Aditor')
}
