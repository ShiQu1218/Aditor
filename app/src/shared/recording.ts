/**
 * Shared types and IPC contract for game recording (phase 2). Spec: `docs/superpowers/specs/2026-10-18-live-recording-design.md`.
 * main (recording service), preload, and renderer (settings page, sidebar, status bar) depend only on this file and do not import each other directly.
 */

import type { EngineEvent } from './types'

/** Built-in recorder or OBS Studio (WebSocket v5). */
export type RecordingBackend = 'builtin' | 'obs'

/** 'match' = record continuously and split by match; 'session' = record from start to finish. */
export type RecordingMode = 'match' | 'session'

/** Full post-recording analysis (R9): none, after Apex exits (default), or at low priority after each match. */
export type PostRecordAnalysis = 'none' | 'afterExit' | 'perMatch'

export type RecordingCodec = 'hevc' | 'h264' | 'av1'

/** `settings.recording` (value ranges are in `RECORDING_RANGES` and validated by main). */
export interface RecordingSettings {
  /** Automatically record when Apex is detected. */
  autoRecord: boolean
  /** Start automatically at login and stay in the system tray (R8, enabled by default). */
  launchAtLogin: boolean
  /** Minimize to the system tray instead of quitting when the main window closes. */
  closeToTray: boolean
  backend: RecordingBackend
  obsHost: string
  obsPort: number
  /** safeStorage ciphertext (base64), held only by the main process and removed before IPC responses. */
  obsPasswordEnc?: string | null
  /** The renderer receives only whether a password is configured. */
  hasPassword?: boolean
  /** Used only by settings IPC writes; excluded from settings snapshots and persistence. */
  obsPassword?: string
  obsFallbackBuiltin: boolean
  mode: RecordingMode
  /** Recording folder; null uses the first watched folder, or `Aditor` under the Videos folder if none are watched. */
  outputDir: string | null
  codec: RecordingCodec
  /** 'auto' or an adapter id reported by aditorrec `hello`; chooses the GPU used for window capture and encoding. */
  gpu: string
  /** 'auto' or the encoder name reported by aditorrec `hello`. */
  encoder: string
  fps: 10 | 20 | 30 | 60 | 90 | 120
  preset: 'speed' | 'balanced' | 'quality'
  forceAspect: boolean
  aspectMode: 'fit' | 'stretch'
  /** 0 = native resolution; otherwise the output height (720/1080/1440). */
  height: 0 | 720 | 1080 | 1440
  bitrateKbps: number
  /** 'default' or a WASAPI device ID. */
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
  /** Warn when free space falls below this value (GB). */
  diskWarnGb: number
  /** Stop recording and finalize when free space falls below this value (GB). */
  diskStopGb: number
  /** Whether to show Windows notifications when a match starts or ends (errors always notify). */
  notifyMatch: boolean
  captureCursor: boolean
  /**
   * Capture method: 'auto' (default) = 'dda' on Windows 10, whose window capture always shows a yellow border, and 'wgc'
   * elsewhere; 'wgc' = window capture; 'dda' = screen capture (DXGI Desktop Duplication);
   * 'hook' = optional OBS graphics-hook, selected explicitly and never by auto.
   */
  captureMethod: RecordingCaptureMethod
  /** Show the Aditor window automatically when Apex exits. */
  openOnGameExit: boolean
}

export type RecordingCaptureMethod = 'auto' | 'wgc' | 'dda' | 'hook'

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
  gpu: 'auto',
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
  captureCursor: true,
  captureMethod: 'auto',
  openOnGameExit: true
}

/** Recording service status (pushed from main to renderer on `recording:status`, also available via `recording:getStatus`). */
export type RecordingPhase =
  /** Apex is not running or automatic recording is disabled. */
  | 'idle'
  /** Apex detected; aditorrec is starting. */
  | 'starting'
  | 'recording'
  /** Joining segments and adding to the media library. */
  | 'finalizing'
  /** aditorrec repeatedly failed to restart or no hardware encoder is available; `error` contains a message. */
  | 'error'

export interface RecordingStatus {
  phase: RecordingPhase
  backend: RecordingBackend
  /** Whether OBS is currently writing a video; false in the lobby in match mode. */
  obsRecording?: boolean
  /** Only live detection runs when OBS cannot connect and fallback is disabled. */
  detectionOnly?: boolean
  /** Current recording job; null when idle. */
  sessionId: string | null
  /** Recording start time in epoch milliseconds. */
  startedAt: number | null
  /** Actual encoder and dimensions reported by aditorrec `started`. */
  encoder: string | null
  width: number | null
  height: number | null
  /** Number of written segments and total duration in seconds. */
  segments: number
  durationSec: number
  /** Free bytes on the volume containing the recording folder; null if unknown. */
  diskFreeBytes: number | null
  /** Most recent aditorrec `stats`. */
  droppedFrames: number
  /** Whether automatic recording is paused (system tray: "Pause automatic recording"). */
  paused: boolean
  error: { code: string; message: string } | null
  /** Counted knocks plus eliminations in this match (or the full recording before match data is available; live engine, phase 3). */
  kills: number
  /** Match number (starting at 1); null before match data is available. */
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

/** A recording GPU reported by aditorrec `hello`. */
export interface RecorderGpu {
  /** Stable adapter id accepted by the `gpu` setting. */
  id: string
  name: string
  /** Lower-case vendor name: nvidia, amd, intel, or other. */
  vendor: string
  /** Hardware encoders that work on this GPU. */
  encoders: string[]
}

/** Capabilities from aditorrec `hello` (used by the settings menu). */
export interface RecorderCapabilities {
  version: string
  encoders: string[]
  /** Empty for older recorders that do not report per-GPU information. */
  gpus: RecorderGpu[]
  /** What the 'auto' capture method resolves to on this machine; added by the main process, not by aditorrec. */
  autoCaptureMethod?: 'wgc' | 'dda'
  audio: {
    render: { id: string; name: string; default: boolean }[]
    capture: { id: string; name: string; default: boolean }[]
  }
}

/** Public interface for the main-process recording service (implemented in `main/recording/`; only `recording-ipc.ts` and the system tray depend on it). */
export interface RecordingService {
  testObs?(): Promise<ObsTestResult>
  start(): void
  stop(): Promise<void>
  /** Start manually regardless of autoRecord; returns false if Apex is not running. */
  startManual(): Promise<boolean>
  /** Stop and finalize the current recording manually. */
  stopManual(): Promise<void>
  setPaused(paused: boolean): void
  status(): RecordingStatus
  capabilities(): Promise<RecorderCapabilities | null>
  onStatus(listener: (s: RecordingStatus) => void): () => void
  /** Files produced during finalization (already added to the media library). */
  onFinalized(listener: (videoPaths: string[]) => void): () => void
  /** Watch while recording (phase 3): segments, events, and matches for the current recording job; null when not recording. */
  live?(): Promise<LiveState | null>
  /** Read init.mp4 for the current recording job, including one being finalized. */
  readInit?(sessionId: string): Promise<Uint8Array>
  /** Read a segment for the current recording job, including one being finalized; seq must be indexed. */
  readSegment?(sessionId: string, seq: number): Promise<Uint8Array>
  /** Segment and event updates (pushed by main on `recording:live`). */
  onLive?(listener: (update: LiveUpdate) => void): () => void
}

export type ObsTestResult = { ok: true; obsVersion: string; obsWebSocketVersion: string } | { ok: false; error: string }

/** Indexed fMP4 segment (seconds; 0 = recording start). */
export interface LiveSegment { seq: number; pts: number; dur: number }

/** Match start and end (seconds); end is null while in progress. */
export interface LiveMatch { start: number; end: number | null }

/** Live engine event (fields match the analysis cache's `events`; see `EngineEvent` in `shared/types.ts`). */
export type LiveEvent = EngineEvent

export interface LiveState {
  sessionId: string
  /** `video/mp4; codecs="…"` parsed from init.mp4; null until init.mp4 is written. */
  mime: string | null
  segments: LiveSegment[]
  events: LiveEvent[]
  spectating: { start: number; end: number }[]
  matches: LiveMatch[]
}

/**
 * `recording:live` update. `segment`/`match` are incremental; `events`/`spectating` are complete lists
 * from the latest live engine snapshot (the snapshot is the full list, sent at most once per second). `finalized` contains output files after recording finalization.
 */
export interface LiveUpdate {
  sessionId: string
  /** Complete segment list that remains readable after cleanup. */
  segments?: LiveSegment[]
  segment?: LiveSegment
  events?: LiveEvent[]
  spectating?: { start: number; end: number }[]
  match?: LiveMatch & { index: number }
  finalized?: string[]
}

/** IPC channel names (invoke and push). */
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
  /** Push: segment and event updates (`LiveUpdate`). */
  live: 'recording:live'
} as const
