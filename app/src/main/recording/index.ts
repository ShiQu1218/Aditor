/**
 * Recording service (phase 2, task A1): detect Apex → drive aditorrec → finalize to MP4 → add to the library/enqueue analysis.
 * The interface is fixed by the skeleton (`RecordingDeps` and `createRecordingService` signatures); implementations live in the other files in this directory.
 */
import type { RecordingService, RecordingSettings } from '../../shared/recording'
import { RecordingSessionService } from './session'
import type { StorageKind } from './storage-location'

export interface RecorderCommand {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type RecordingNoticeKind = 'matchStart' | 'matchEnd' | 'matchCancel' | 'finalized' | 'diskWarn' | 'warning' | 'error'

export interface RecordingDeps {
  /** Decrypt the password with safeStorage in the main process; never return it through status or settings IPC. */
  getObsPassword?: () => string | undefined
  /** Test injection: milliseconds to retain OBS recording after each match (defaults to MATCH_POST_PAD_SEC). */
  obsMatchPostPadMs?: number
  obsReconnectBaseMs?: number
  /** Test injection: polling interval in milliseconds while waiting for OBS to finish writing (defaults to 1000). */
  obsFileSettleMs?: number
  /** Test injection: after stopping our OBS recording, how long to treat an active status as stopping rather than a user-owned recording (defaults to 30000). */
  obsStopGraceMs?: number
  /** Delay in milliseconds between detecting Apex and starting capture (defaults to 20000; tests inject 0). */
  gameStartDelayMs?: number
  /** Diagnostic log, flushed line by line so recorder activity remains visible after a system crash. */
  log?: (message: string) => void
  probeVideo?: (file: string) => Promise<{ duration: number; width?: number; height?: number; codec?: string }>
  /** Read on demand so settings changes take effect without a restart. */
  getSettings: () => RecordingSettings
  getWatchFolders: () => string[]
  /** Recording directory when neither outputDir nor a watched folder is set (`<Videos>/Aditor`, built by A3 from app.getPath('videos')). */
  defaultOutputDir: string
  /** How to launch aditorrec.exe (paths.ts, provided by task A3). */
  recorderCommand: RecorderCommand
  /** ffmpeg.exe used to concatenate segments during finalization. */
  ffmpegPath: string
  /** `templates/icons`: read `banner_roi`/`spec_roi` from `profile.json` and pass them to aditorrec. */
  profileDir: string
  /** Add an item to the library (`Library.add`). */
  addToLibrary: (paths: string[]) => void
  /** Enqueue a full analysis (`AnalysisQueue.enqueue`). */
  enqueueAnalysis: (videoPath: string) => void
  /** Windows notification/tray notice (implemented by task A3; visibility follows its settings). */
  notify: (kind: RecordingNoticeKind, message: string) => void
  /** Test injection: list Apex process PIDs (defaults to querying r5apex*.exe with tasklist every 3 seconds). */
  findApexPid?: () => Promise<number | null>
  /** Test injection: classify the output folder as cloud-synced or network storage (defaults to probeStorageKind). */
  probeStorage?: (dir: string) => Promise<StorageKind | null>
  /** Test injection: polling interval in milliseconds. */
  pollMs?: number
  /** Phase 3: how to launch the live engine (`aditor live`); when omitted, skip live detection and provide segment playback only. */
  liveEngineCommand?: RecorderCommand
  /** `templates/scene` (the live engine's `--scene-dir`, used to detect matches). */
  sceneDir?: string
  /** Test injection: base backoff in milliseconds before restarting the live engine (defaults to 1000). */
  liveRestartBaseMs?: number
  /** Convert `live.json` to the output video's analysis cache during finalization; return its path using the current cache location, or omit to skip conversion. */
  liveCachePath?: (videoPath: string) => string
  /** Notify after writing the live cache and before queuing full analysis, for example to mark the library item playable and set its kill count. */
  onLiveAnalysis?: (videoPath: string, summary: LiveAnalysisSummary) => void
  /** Called once when Apex changes from running to closed while `openOnGameExit` is enabled. */
  onGameExit?: () => void
}

export interface LiveAnalysisSummary {
  counts: { knock: number; assist: number }
  durationSec: number
  codec: string
  /** Live results are equivalent to offline analysis (the cache has the official version), so a full analysis is unnecessary. */
  trusted: boolean
}

export function createRecordingService(_deps: RecordingDeps): RecordingService {
  return new RecordingSessionService(_deps)
}
