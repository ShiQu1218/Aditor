/**
 * 錄影服務（第 2 期任務 A1）：偵測 Apex → 驅動 apexrec → 收尾成 mp4 → 加入媒體庫／排分析。
 * 介面由骨架固定（`RecordingDeps`、`createRecordingService` 簽章），實作放在本資料夾其他檔案。
 */
import type { RecordingService, RecordingSettings } from '../../shared/recording'
import { RecordingSessionService } from './session'

export interface RecorderCommand {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type RecordingNoticeKind = 'matchStart' | 'matchEnd' | 'finalized' | 'diskWarn' | 'warning' | 'error'

export interface RecordingDeps {
  /** 密碼只在主程序由 safeStorage 解密，不經狀態或設定 IPC 回傳。 */
  getObsPassword?: () => string | undefined
  obsReconnectBaseMs?: number
  probeVideo?: (file: string) => Promise<{ duration: number; width?: number; height?: number; codec?: string }>
  /** 每次需要時才讀，設定變更免重啟 */
  getSettings: () => RecordingSettings
  getWatchFolders: () => string[]
  /** 沒有 outputDir 也沒有監看資料夾時的錄影資料夾（`<影片>/Apex Highlighter`，A3 由 app.getPath('videos') 組出） */
  defaultOutputDir: string
  /** apexrec.exe 的啟動方式（paths.ts 由任務 A3 提供） */
  recorderCommand: RecorderCommand
  /** 收尾串接用的 ffmpeg.exe */
  ffmpegPath: string
  /** `templates/icons`：讀 `profile.json` 的 `banner_roi`／`spec_roi` 傳給 apexrec */
  profileDir: string
  /** 加入媒體庫（`Library.add`） */
  addToLibrary: (paths: string[]) => void
  /** 排入完整分析（`AnalysisQueue.enqueue`） */
  enqueueAnalysis: (videoPath: string) => void
  /** Windows 通知／系統匣提示（任務 A3 實作；是否顯示由實作依設定決定） */
  notify: (kind: RecordingNoticeKind, message: string) => void
  /** 測試注入：列出 Apex 程序 PID（預設每 3 秒以 tasklist 查 r5apex*.exe） */
  findApexPid?: () => Promise<number | null>
  /** 測試注入：輪詢間隔毫秒 */
  pollMs?: number
  /** 第 3 期：live 引擎（`apexhl live`）的啟動方式；未提供＝不做即時偵測，只提供段落播放 */
  liveEngineCommand?: RecorderCommand
  /** `templates/scene`（live 引擎 `--scene-dir`，對局判斷用） */
  sceneDir?: string
  /** 測試注入：live 引擎重啟退避基準毫秒（預設 1000） */
  liveRestartBaseMs?: number
  /** 收尾時把 `live.json` 寫成輸出影片的分析快取：回傳快取檔路徑（與 `cacheFilePath` 及目前快取位置設定一致）；未提供＝不轉換 */
  liveCachePath?: (videoPath: string) => string
  /** live 快取寫好後（在排完整分析之前）通知：例如把媒體庫條目標成可開啟並填入擊殺數 */
  onLiveAnalysis?: (videoPath: string, summary: LiveAnalysisSummary) => void
}

export interface LiveAnalysisSummary {
  counts: { knock: number; assist: number }
  durationSec: number
  codec: string
  /** live 結果等同離線分析（快取已標成正式版本），不必再排完整分析 */
  trusted: boolean
}

export function createRecordingService(_deps: RecordingDeps): RecordingService {
  return new RecordingSessionService(_deps)
}
