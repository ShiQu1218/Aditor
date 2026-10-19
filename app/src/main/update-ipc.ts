import { BrowserWindow, ipcMain, shell } from 'electron'
import { RELEASES_URL, UPDATE_CHANNELS, type UpdateStatus } from '../shared/update'
import type { AppUpdaterService } from './updater'

/** 推送更新狀態給所有視窗；視窗關閉中送失敗不影響更新流程。 */
export function broadcastUpdateStatus(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(UPDATE_CHANNELS.status, status)
    } catch (error) {
      console.error('無法推送更新狀態：', error)
    }
  }
}

/** 設定頁用的更新 IPC；回傳解除註冊函式。 */
export function registerUpdateIpc(service: AppUpdaterService): () => void {
  ipcMain.handle(UPDATE_CHANNELS.getStatus, () => service.status())
  ipcMain.handle(UPDATE_CHANNELS.check, () => service.check())
  ipcMain.handle(UPDATE_CHANNELS.install, () => service.install())
  // 只開固定的 Releases 網址，不接受 renderer 傳入的網址
  ipcMain.handle(UPDATE_CHANNELS.openReleases, async () => {
    await shell.openExternal(RELEASES_URL)
    return true
  })
  return () => {
    for (const channel of [UPDATE_CHANNELS.getStatus, UPDATE_CHANNELS.check, UPDATE_CHANNELS.install, UPDATE_CHANNELS.openReleases]) {
      ipcMain.removeHandler(channel)
    }
  }
}
