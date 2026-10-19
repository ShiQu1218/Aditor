/** 自動更新（electron-updater + GitHub Releases）的 IPC 通道與狀態。 */

export const UPDATE_CHANNELS = {
  getStatus: 'update:getStatus',
  check: 'update:check',
  install: 'update:install',
  openReleases: 'update:openReleases',
  status: 'update:status'
} as const

/** 手動下載新版的頁面（免安裝版或更新失敗時使用）。 */
export const RELEASES_URL = 'https://github.com/ShiQu1218/Aditor/releases/latest'

export type UpdateState =
  /** 開發模式或免安裝版：無法自動更新 */
  | 'unsupported'
  /** 尚未檢查 */
  | 'idle'
  | 'checking'
  /** 已是最新版本 */
  | 'latest'
  | 'downloading'
  /** 已下載，結束 Aditor 時安裝 */
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  /** 新版本號（downloading／downloaded） */
  version?: string
  /** 下載進度 0–100（downloading） */
  percent?: number
  /** 錯誤訊息（error） */
  error?: string
}
