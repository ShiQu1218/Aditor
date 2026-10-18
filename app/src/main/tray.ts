import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import type { RecordingService, RecordingStatus } from '../shared/recording'

interface TrayHandle {
  setImage(image: string): void
  setToolTip(text: string): void
  setContextMenu(menu: Menu): void
  on(event: 'double-click', listener: () => void): unknown
  destroy(): void
}

interface TrayDependencies {
  createTray: (image: string) => TrayHandle
  buildMenu: (items: MenuItemConstructorOptions[]) => Menu
}

interface RecordingTrayOptions {
  service: RecordingService
  iconDir: string
  openWindow: () => void
  quit: () => void
  notifyError: (message: string) => void
}

const phaseLabels: Record<RecordingStatus['phase'], string> = {
  idle: '待命', starting: '正在啟動錄影', recording: '錄影中', finalizing: '正在儲存錄影', error: '錄影錯誤'
}

export function createRecordingTray(opts: RecordingTrayOptions, deps: TrayDependencies = {
  createTray: (image) => new Tray(image),
  buildMenu: (items) => Menu.buildFromTemplate(items)
}): { destroy(): void } {
  const icon = (status: RecordingStatus): string => join(opts.iconDir,
    `tray-${status.phase === 'error' ? 'error' : status.phase === 'recording' ? 'recording' : 'idle'}.png`)
  const tray = deps.createTray(icon(opts.service.status()))
  let disposed = false
  const run = (action: () => Promise<unknown> | void): void => {
    void Promise.resolve().then(action).catch((error) => opts.notifyError(`錄影操作失敗：${String(error)}`))
  }
  let shownImage = ''
  let shownMenu = ''
  const update = (status: RecordingStatus): void => {
    if (disposed) return
    const image = icon(status)
    if (image !== shownImage) tray.setImage(image)
    shownImage = image
    const label = status.phase === 'recording' ? status.detectionOnly ? '即時偵測中（未錄影）' : status.backend === 'obs' ? status.obsRecording === false ? '待命（OBS，等待對局）' : '錄影中（OBS）' : phaseLabels[status.phase] : phaseLabels[status.phase]
    tray.setToolTip(`Apex Highlighter — ${label}`)
    const active = status.phase === 'starting' || status.phase === 'recording'
    // 錄影中狀態每幾秒推播一次；選單開著時被換掉，點選就不會觸發，所以內容沒變就不重建。
    const menuKey = `${active}|${status.phase === 'finalizing'}|${status.paused}`
    if (menuKey === shownMenu) return
    shownMenu = menuKey
    tray.setContextMenu(deps.buildMenu([
      { label: '打開 Apex Highlighter', click: opts.openWindow },
      { type: 'separator' },
      {
        label: active ? '停止錄影' : '開始錄影',
        enabled: status.phase !== 'finalizing',
        click: () => run(async () => {
          if (active) await opts.service.stopManual()
          else if (!await opts.service.startManual()) {
            opts.notifyError(opts.service.status().error?.message ?? '無法開始錄影，請確認 Apex 正在執行。')
          }
        })
      },
      {
        label: '暫停自動錄影', type: 'checkbox', checked: status.paused,
        click: () => run(() => opts.service.setPaused(!opts.service.status().paused))
      },
      { type: 'separator' },
      { label: '結束', click: opts.quit }
    ]))
  }
  tray.on('double-click', opts.openWindow)
  const unsubscribe = opts.service.onStatus(update)
  update(opts.service.status())
  return {
    destroy() {
      if (disposed) return
      disposed = true
      unsubscribe()
      tray.destroy()
    }
  }
}
