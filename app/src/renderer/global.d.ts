import type { LiveState, LiveUpdate, RecordingStatus, RecorderCapabilities } from '../shared/recording'

/** 錄影介面僅由 preload 提供。其餘舊 API 保留既有相容性。 */
export interface RecordingApi {
  getStatus(): Promise<RecordingStatus>
  getCapabilities(): Promise<RecorderCapabilities | null>
  startManual(): Promise<boolean>
  stopManual(): Promise<void>
  setPaused(paused: boolean): Promise<void>
  onStatus(callback: (status: RecordingStatus) => void): () => void
  /** 錄影中觀看（第 3 期；preload 一律提供，測試替身可省略） */
  getLive?(): Promise<LiveState | null>
  readInit?(sessionId: string): Promise<Uint8Array>
  readSegment?(sessionId: string, seq: number): Promise<Uint8Array>
  onLive?(callback: (update: LiveUpdate) => void): () => void
}

declare global {
  interface Window {
    api: { recording: RecordingApi } & Record<'engine' | 'library' | 'queue' | 'cache' | 'proxy' | 'projects' | 'app' | 'settings' | 'export', any>
  }
}
