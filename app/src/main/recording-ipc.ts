/**
 * Recording IPC (Phase 2, Task A2): connect `RecordingService` to `RECORDING_CHANNELS`
 * and broadcast status changes to every window (`recording:status`). Return an unregister function.
 * Phase 3 adds live recording views: `recording:getLive`/`readInit`/`readSegment` and the `recording:live` broadcast.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { RECORDING_CHANNELS, type RecordingService } from '../shared/recording'
import { tr } from '../shared/locale'

const SESSION_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/

/** Recording job IDs must match `YYYYMMDD-HHMMSS-xxxx` (cannot contain path separators). */
export function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error(tr('錄影工作 ID 無效'))
  return value
}

export function requireSegmentSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(tr('段落序號無效'))
  return value
}

export function registerRecordingIpc(service: RecordingService, windows: () => BrowserWindow[]): () => void {
  ipcMain.handle(RECORDING_CHANNELS.testObs, () => service.testObs?.() ?? { ok: false, error: tr('OBS 連線測試無法使用') })
  ipcMain.handle(RECORDING_CHANNELS.getStatus, () => service.status())
  ipcMain.handle(RECORDING_CHANNELS.getCapabilities, () => service.capabilities())
  ipcMain.handle(RECORDING_CHANNELS.startManual, () => service.startManual())
  ipcMain.handle(RECORDING_CHANNELS.stopManual, () => service.stopManual())
  ipcMain.handle(RECORDING_CHANNELS.setPaused, (_event, paused: unknown) => {
    if (typeof paused !== 'boolean') throw new Error(tr('暫停自動錄影必須是布林值'))
    service.setPaused(paused)
  })
  ipcMain.handle(RECORDING_CHANNELS.getLive, async () => (service.live ? service.live() : null))
  ipcMain.handle(RECORDING_CHANNELS.readInit, (_event, sessionId: unknown) => {
    const id = requireSessionId(sessionId)
    if (!service.readInit) throw new Error(tr('錄影服務不支援錄影中觀看'))
    return service.readInit(id)
  })
  ipcMain.handle(RECORDING_CHANNELS.readSegment, (_event, sessionId: unknown, seq: unknown) => {
    const id = requireSessionId(sessionId)
    const n = requireSegmentSeq(seq)
    if (!service.readSegment) throw new Error(tr('錄影服務不支援錄影中觀看'))
    return service.readSegment(id, n)
  })
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of windows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(channel, payload)
        }
      } catch (err) {
        console.error('無法推送錄影狀態：', err)
      }
    }
  }
  const unsubscribe = service.onStatus((status) => broadcast(RECORDING_CHANNELS.status, status))
  const unsubscribeLive = service.onLive?.((update) => broadcast(RECORDING_CHANNELS.live, update))
  return () => {
    unsubscribe()
    unsubscribeLive?.()
    for (const channel of [RECORDING_CHANNELS.testObs, RECORDING_CHANNELS.getStatus, RECORDING_CHANNELS.getCapabilities,
      RECORDING_CHANNELS.startManual, RECORDING_CHANNELS.stopManual, RECORDING_CHANNELS.setPaused,
      RECORDING_CHANNELS.getLive, RECORDING_CHANNELS.readInit, RECORDING_CHANNELS.readSegment]) {
      ipcMain.removeHandler(channel)
    }
  }
}
