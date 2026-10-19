/**
 * 遊戲錄影（第 2 期）的共用型別與 IPC 合約。規格：`docs/superpowers/specs/2026-10-18-live-recording-design.md`。
 * main（錄影服務）、preload 與 renderer（設定頁、側欄、狀態列）都只依賴本檔，彼此不直接 import。
 */

import type { EngineEvent } from './types'

/** 內建錄影器或 OBS Studio（WebSocket v5）。 */
export type RecordingBackend = 'builtin' | 'obs'

/** 'match'＝持續錄影並逐局剪檔；'session'＝從頭錄到尾。 */
export type RecordingMode = 'match' | 'session'

/** 錄後完整分析（R9）：不分析／關閉 Apex 後（預設）／每局結束後以低優先序 */
export type PostRecordAnalysis = 'none' | 'afterExit' | 'perMatch'

export type RecordingCodec = 'hevc' | 'h264' | 'av1'

/** `settings.recording`（數值範圍見 `RECORDING_RANGES`，由 main 驗證）。 */
export interface RecordingSettings {
  /** 偵測到 Apex 就自動錄影 */
  autoRecord: boolean
  /** 開機自動啟動並常駐系統匣（R8，預設開） */
  launchAtLogin: boolean
  /** 關閉主視窗時縮到系統匣而不是結束 */
  closeToTray: boolean
  backend: RecordingBackend
  obsHost: string
  obsPort: number
  /** 僅主程序持有的 safeStorage 密文（base64）；IPC 回傳前移除。 */
  obsPasswordEnc?: string | null
  /** renderer 只取得是否已設定密碼。 */
  hasPassword?: boolean
  /** 僅供設定 IPC 寫入；不納入設定快照或持久化。 */
  obsPassword?: string
  obsFallbackBuiltin: boolean
  mode: RecordingMode
  /** 錄影資料夾；null＝第一個監看資料夾，沒有監看資料夾時用「影片」資料夾下的 `Apex Highlighter` */
  outputDir: string | null
  codec: RecordingCodec
  /** 'auto' 或 apexrec `hello` 回報的編碼器名稱 */
  encoder: string
  fps: 10 | 20 | 30 | 60 | 90 | 120
  preset: 'speed' | 'balanced' | 'quality'
  forceAspect: boolean
  aspectMode: 'fit' | 'stretch'
  /** 0＝原生解析度；否則輸出高度（720／1080／1440） */
  height: 0 | 720 | 1080 | 1440
  bitrateKbps: number
  /** 'default' 或 WASAPI 裝置 ID */
  renderDevice: string
  captureDevice: string
  systemAudioEnabled: boolean
  /** 0..2 */
  systemGain: number
  gameAudioOnly: boolean
  micEnabled: boolean
  micMono: boolean
  /** 0..2 */
  micGain: number
  postAnalysis: PostRecordAnalysis
  /** 低於此值（GB）提醒 */
  diskWarnGb: number
  /** 低於此值（GB）停止錄影並收尾 */
  diskStopGb: number
  /** 對局開始／結束是否發 Windows 通知（錯誤一律通知） */
  notifyMatch: boolean
  /** 擷取方式：'dda'＝擷取遊戲所在的整個螢幕（DXGI Desktop Duplication，預設，遊戲延遲較低）；'wgc'＝視窗擷取 */
  captureMethod: RecordingCaptureMethod
}

export type RecordingCaptureMethod = 'wgc' | 'dda'

export const RECORDING_RANGES = {
  bitrateKbps: { min: 2_000, max: 150_000 },
  micGain: { min: 0, max: 2 },
  systemGain: { min: 0, max: 2 },
  diskWarnGb: { min: 1, max: 500 },
  diskStopGb: { min: 1, max: 100 }
} as const

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  autoRecord: true,
  launchAtLogin: true,
  closeToTray: true,
  backend: 'builtin',
  obsHost: '127.0.0.1',
  obsPort: 4455,
  obsPasswordEnc: null,
  obsFallbackBuiltin: true,
  mode: 'session',
  outputDir: null,
  codec: 'hevc',
  encoder: 'auto',
  fps: 60,
  preset: 'speed',
  forceAspect: false,
  aspectMode: 'fit',
  height: 1080,
  bitrateKbps: 10_000,
  renderDevice: 'default',
  captureDevice: 'default',
  systemAudioEnabled: true,
  systemGain: 1,
  gameAudioOnly: false,
  micEnabled: true,
  micMono: false,
  micGain: 1,
  postAnalysis: 'afterExit',
  diskWarnGb: 10,
  diskStopGb: 2,
  notifyMatch: false,
  captureMethod: 'dda'
}

/** 錄影服務狀態（main → renderer 推播 `recording:status`，也可用 `recording:getStatus` 取）。 */
export type RecordingPhase =
  /** Apex 未執行，或自動錄影關閉 */
  | 'idle'
  /** 偵測到 Apex，apexrec 啟動中 */
  | 'starting'
  | 'recording'
  /** 串接段落、加入媒體庫中 */
  | 'finalizing'
  /** apexrec 連續重啟失敗或無硬體編碼器；`error` 有訊息 */
  | 'error'

export interface RecordingStatus {
  phase: RecordingPhase
  backend: RecordingBackend
  /** OBS 目前是否正在寫入影片；逐局模式在大廳為 false。 */
  obsRecording?: boolean
  /** OBS 無法連線且未回退時，僅執行即時偵測。 */
  detectionOnly?: boolean
  /** 目前錄影工作；idle 時為 null */
  sessionId: string | null
  /** 錄影開始的 epoch ms */
  startedAt: number | null
  /** apexrec `started` 回報的實際編碼器與尺寸 */
  encoder: string | null
  width: number | null
  height: number | null
  /** 已寫入的段落數與總秒數 */
  segments: number
  durationSec: number
  /** 錄影資料夾所在磁碟剩餘 bytes；未知時 null */
  diskFreeBytes: number | null
  /** 最近一次 apexrec `stats` */
  droppedFrames: number
  /** 自動錄影是否暫停（系統匣「暫停自動錄影」） */
  paused: boolean
  error: { code: string; message: string } | null
  /** 本局（尚無對局資訊時＝整段錄影）計入的擊倒＋消滅數（live 引擎；第 3 期） */
  kills: number
  /** 第幾局（從 1 開始）；尚無對局資訊時 null */
  matchIndex: number | null
}

export const IDLE_RECORDING_STATUS: RecordingStatus = {
  phase: 'idle',
  backend: 'builtin',
  obsRecording: false,
  detectionOnly: false,
  sessionId: null,
  startedAt: null,
  encoder: null,
  width: null,
  height: null,
  segments: 0,
  durationSec: 0,
  diskFreeBytes: null,
  droppedFrames: 0,
  paused: false,
  error: null,
  kills: 0,
  matchIndex: null
}

/** apexrec `hello` 的能力資訊（設定頁選單用）。 */
export interface RecorderCapabilities {
  version: string
  encoders: string[]
  audio: {
    render: { id: string; name: string; default: boolean }[]
    capture: { id: string; name: string; default: boolean }[]
  }
}

/** main 端錄影服務對外介面（`main/recording/` 實作；`recording-ipc.ts`、系統匣只依賴這個介面）。 */
export interface RecordingService {
  testObs?(): Promise<ObsTestResult>
  start(): void
  stop(): Promise<void>
  /** 手動開始（不論 autoRecord；Apex 未執行時回傳 false） */
  startManual(): Promise<boolean>
  /** 手動停止目前錄影並收尾 */
  stopManual(): Promise<void>
  setPaused(paused: boolean): void
  status(): RecordingStatus
  capabilities(): Promise<RecorderCapabilities | null>
  onStatus(listener: (s: RecordingStatus) => void): () => void
  /** 收尾產生的檔案（已加入媒體庫） */
  onFinalized(listener: (videoPaths: string[]) => void): () => void
  /** 錄影中觀看（第 3 期）：目前錄影工作的段落、事件與對局；沒有錄影時 null */
  live?(): Promise<LiveState | null>
  /** 讀目前（或收尾中）錄影工作的 init.mp4 */
  readInit?(sessionId: string): Promise<Uint8Array>
  /** 讀目前（或收尾中）錄影工作的段落；seq 必須已寫入索引 */
  readSegment?(sessionId: string, seq: number): Promise<Uint8Array>
  /** 段落與事件增量（main 推播 `recording:live`） */
  onLive?(listener: (update: LiveUpdate) => void): () => void
}

export type ObsTestResult = { ok: true; obsVersion: string; obsWebSocketVersion: string } | { ok: false; error: string }

/** 已寫入索引的 fMP4 段落（秒；0＝錄影開始）。 */
export interface LiveSegment { seq: number; pts: number; dur: number }

/** 對局起訖（秒）；進行中 end＝null。 */
export interface LiveMatch { start: number; end: number | null }

/** live 引擎事件（欄位與分析快取 `events` 相同，見 `shared/types.ts` 的 `EngineEvent`）。 */
export type LiveEvent = EngineEvent

export interface LiveState {
  sessionId: string
  /** `video/mp4; codecs="…"`（由 init.mp4 解析）；init.mp4 尚未寫出時 null */
  mime: string | null
  segments: LiveSegment[]
  events: LiveEvent[]
  spectating: { start: number; end: number }[]
  matches: LiveMatch[]
}

/**
 * `recording:live` 推播。`segment`／`match` 是增量；`events`／`spectating` 是 live 引擎最新快照的完整清單
 * （快照本身就是整份清單，最多每秒一次）。`finalized`：錄影收尾後的輸出檔。
 */
export interface LiveUpdate {
  sessionId: string
  /** 清理後仍可讀取的完整段落清單。 */
  segments?: LiveSegment[]
  segment?: LiveSegment
  events?: LiveEvent[]
  spectating?: { start: number; end: number }[]
  match?: LiveMatch & { index: number }
  finalized?: string[]
}

/** IPC 頻道名稱（invoke 與推播）。 */
export const RECORDING_CHANNELS = {
  testObs: 'recording:testObs',
  getStatus: 'recording:getStatus',
  getCapabilities: 'recording:getCapabilities',
  startManual: 'recording:startManual',
  stopManual: 'recording:stopManual',
  setPaused: 'recording:setPaused',
  status: 'recording:status',
  getLive: 'recording:getLive',
  readInit: 'recording:readInit',
  readSegment: 'recording:readSegment',
  /** 推播：段落與事件增量（`LiveUpdate`） */
  live: 'recording:live'
} as const
