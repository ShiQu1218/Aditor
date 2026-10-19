import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import type { RecordingService, RecordingStatus } from '../shared/recording'
import { getActiveLocale, tr } from '../shared/locale'

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

/** 文字在每次更新時才取值，語言切換後立即反映。 */
function phaseLabel(phase: RecordingStatus['phase']): string {
  switch (phase) {
    case 'idle': return tr('待命')
    case 'starting': return tr('正在啟動錄影')
    case 'recording': return tr('錄影中')
    case 'finalizing': return tr('正在儲存錄影')
    case 'error': return tr('錄影錯誤')
  }
}

function statusLabel(status: RecordingStatus): string {
  if (status.phase !== 'recording') return phaseLabel(status.phase)
  if (status.detectionOnly) return tr('即時偵測中（未錄影）')
  if (status.backend !== 'obs') return phaseLabel(status.phase)
  return status.obsRecording === false ? tr('待命（OBS，等待對局）') : tr('錄影中（OBS）')
}

export function createRecordingTray(opts: RecordingTrayOptions, deps: TrayDependencies = {
  createTray: (image) => new Tray(image),
  buildMenu: (items) => Menu.buildFromTemplate(items)
}): { destroy(): void; refresh(): void } {
  const icon = (status: RecordingStatus): string => join(opts.iconDir,
    `tray-${status.phase === 'error' ? 'error' : status.phase === 'recording' ? 'recording' : 'idle'}.png`)
  const tray = deps.createTray(icon(opts.service.status()))
  let disposed = false
  const run = (action: () => Promise<unknown> | void): void => {
    void Promise.resolve().then(action).catch((error) => opts.notifyError(tr('錄影操作失敗：{error}', { error: String(error) })))
  }
  let shownImage = ''
  let imageFailed = false
  let shownMenu = ''
  const update = (status: RecordingStatus): void => {
    if (disposed) return
    const image = icon(status)
    if (image !== shownImage) {
      // 圖示檔遺失（例如免安裝版的暫存目錄被清掉）不能讓狀態推播變成未捕捉例外；提示與選單照常更新。
      try { tray.setImage(image) }
      catch (error) { if (!imageFailed) console.error('[tray] 無法載入圖示：', error); imageFailed = true }
    }
    shownImage = image
    const label = statusLabel(status)
    tray.setToolTip(`Aditor — ${label}`)
    const active = status.phase === 'starting' || status.phase === 'recording'
    // 錄影中狀態每幾秒推播一次；選單開著時被換掉，點選就不會觸發，所以內容沒變就不重建。
    const menuKey = `${getActiveLocale()}|${active}|${status.phase === 'finalizing'}|${status.paused}`
    if (menuKey === shownMenu) return
    shownMenu = menuKey
    tray.setContextMenu(deps.buildMenu([
      { label: tr('打開 Aditor'), click: opts.openWindow },
      { type: 'separator' },
      {
        label: active ? tr('停止錄影') : tr('開始錄影'),
        enabled: status.phase !== 'finalizing',
        click: () => run(async () => {
          if (active) await opts.service.stopManual()
          else if (!await opts.service.startManual()) {
            opts.notifyError(opts.service.status().error?.message ?? tr('無法開始錄影，請確認 Apex 正在執行。'))
          }
        })
      },
      {
        label: tr('暫停自動錄影'), type: 'checkbox', checked: status.paused,
        click: () => run(() => opts.service.setPaused(!opts.service.status().paused))
      },
      { type: 'separator' },
      { label: tr('結束'), click: opts.quit }
    ]))
  }
  tray.on('double-click', opts.openWindow)
  const unsubscribe = opts.service.onStatus(update)
  update(opts.service.status())
  return {
    /** 語言切換後重新套用提示文字與選單。 */
    refresh() { update(opts.service.status()) },
    destroy() {
      if (disposed) return
      disposed = true
      unsubscribe()
      tray.destroy()
    }
  }
}
