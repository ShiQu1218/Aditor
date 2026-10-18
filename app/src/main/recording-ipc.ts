/**
 * 錄影 IPC（第 2 期任務 A2）：把 `RecordingService` 掛到 `RECORDING_CHANNELS`，
 * 並把狀態變化推播給所有視窗（`recording:status`）。回傳解除註冊函式。
 */
import type { BrowserWindow } from 'electron'
import type { RecordingService } from '../shared/recording'

export function registerRecordingIpc(_service: RecordingService, _windows: () => BrowserWindow[]): () => void {
  throw new Error('錄影 IPC 尚未實作（任務 A2）')
}
