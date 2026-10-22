/** IPC channels and status for automatic updates (electron-updater + GitHub Releases). */

export const UPDATE_CHANNELS = {
  getStatus: 'update:getStatus',
  check: 'update:check',
  /** Explicit user action: download an available update; checks never download. */
  download: 'update:download',
  install: 'update:install',
  openReleases: 'update:openReleases',
  status: 'update:status'
} as const

/** Page for manually downloading a new version (used for portable builds or when an update fails). */
export const RELEASES_URL = 'https://github.com/ShiQu1218/Aditor/releases/latest'

export type UpdateState =
  /** Development mode or portable build: automatic updates are unavailable. */
  | 'unsupported'
  /** Not checked yet. */
  | 'idle'
  | 'checking'
  /** Already up to date. */
  | 'latest'
  /** A newer version was found; nothing is downloaded until the user chooses Download update. */
  | 'available'
  | 'downloading'
  /** Downloaded and ready; the installer starts only when the user explicitly installs. */
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  /** New version number (available/downloading/downloaded). */
  version?: string
  /** Download progress, 0–100 (downloading). */
  percent?: number
  /** Error message (error). */
  error?: string
}
