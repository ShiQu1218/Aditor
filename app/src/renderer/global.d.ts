import type { LiveState, LiveUpdate, RecordingStatus, RecorderCapabilities, ObsTestResult } from '../shared/recording'
import type { PlaybackDesyncReport } from '../shared/telemetry'

/** Recording APIs are provided only by preload. Other legacy APIs remain for compatibility. */
export interface RecordingApi {
  testObs?(): Promise<ObsTestResult>
  getStatus(): Promise<RecordingStatus>
  getCapabilities(): Promise<RecorderCapabilities | null>
  startManual(): Promise<boolean>
  stopManual(): Promise<void>
  setPaused(paused: boolean): Promise<void>
  onStatus(callback: (status: RecordingStatus) => void): () => void
  /** Live recording view (phase 3; always provided by preload, but optional in test doubles). */
  getLive?(): Promise<LiveState | null>
  readInit?(sessionId: string): Promise<Uint8Array>
  readSegment?(sessionId: string, seq: number): Promise<Uint8Array>
  onLive?(callback: (update: LiveUpdate) => void): () => void
}

declare global {
  interface Window {
    api: { recording: RecordingApi; telemetry?: { enabled(): Promise<boolean>; report(message: string): Promise<boolean>; reportPlaybackDesync(report: PlaybackDesyncReport): Promise<boolean> } } & Record<'engine' | 'library' | 'queue' | 'cache' | 'proxy' | 'projects' | 'app' | 'settings' | 'export' | 'update', any>
  }
}
