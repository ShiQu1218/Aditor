import { BrowserWindow, ipcMain, shell } from 'electron'
import { RELEASES_URL, UPDATE_CHANNELS, type UpdateStatus } from '../shared/update'
import type { AppUpdaterService } from './updater'

/** Send update status to every window; a send failure while a window is closing does not affect the update flow. */
export function broadcastUpdateStatus(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(UPDATE_CHANNELS.status, status)
    } catch (error) {
      console.error('無法推送更新狀態：', error)
    }
  }
}

/** Update IPC for Settings; return an unregister function. */
export function registerUpdateIpc(service: AppUpdaterService): () => void {
  ipcMain.handle(UPDATE_CHANNELS.getStatus, () => service.status())
  ipcMain.handle(UPDATE_CHANNELS.check, () => service.check())
  ipcMain.handle(UPDATE_CHANNELS.download, () => service.download())
  ipcMain.handle(UPDATE_CHANNELS.install, () => service.install())
  // Open only the fixed Releases URL; do not accept a URL from the renderer.
  ipcMain.handle(UPDATE_CHANNELS.openReleases, async () => {
    await shell.openExternal(RELEASES_URL)
    return true
  })
  return () => {
    for (const channel of [UPDATE_CHANNELS.getStatus, UPDATE_CHANNELS.check, UPDATE_CHANNELS.download, UPDATE_CHANNELS.install, UPDATE_CHANNELS.openReleases]) {
      ipcMain.removeHandler(channel)
    }
  }
}
