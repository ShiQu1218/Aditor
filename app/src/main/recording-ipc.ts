/**
 * 錄影 IPC（第 2 期任務 A2）：把 `RecordingService` 掛到 `RECORDING_CHANNELS`，
 * 並把狀態變化推播給所有視窗（`recording:status`）。回傳解除註冊函式。
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { RECORDING_CHANNELS, type RecordingService } from '../shared/recording'

export function registerRecordingIpc(service: RecordingService, windows: () => BrowserWindow[]): () => void {
  ipcMain.handle(RECORDING_CHANNELS.getStatus, () => service.status())
  ipcMain.handle(RECORDING_CHANNELS.getCapabilities, () => service.capabilities())
  ipcMain.handle(RECORDING_CHANNELS.startManual, () => service.startManual())
  ipcMain.handle(RECORDING_CHANNELS.stopManual, () => service.stopManual())
  ipcMain.handle(RECORDING_CHANNELS.setPaused, (_event, paused: unknown) => {
    if (typeof paused !== 'boolean') throw new Error('暫停自動錄影必須是布林值')
    service.setPaused(paused)
  })
  const unsubscribe = service.onStatus((status) => {
    for (const win of windows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(RECORDING_CHANNELS.status, status)
        }
      } catch (err) {
        console.error('無法推送錄影狀態：', err)
      }
    }
  })
  return () => {
    unsubscribe()
    for (const channel of [RECORDING_CHANNELS.getStatus, RECORDING_CHANNELS.getCapabilities,
      RECORDING_CHANNELS.startManual, RECORDING_CHANNELS.stopManual, RECORDING_CHANNELS.setPaused]) {
      ipcMain.removeHandler(channel)
    }
  }
}
