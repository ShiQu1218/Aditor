import { i18n } from '../i18n'
import { tr } from '../../shared/locale'
import { exportSubDirName, joinForDisplay } from '../../shared/storage'

/**
 * Export drawer state machine (pure TS, no React/DOM dependency; window.api is injected for testing with a fake API).
 * All IPC subscriptions are managed here: progress events are subscribed only during start()/download and unsubscribed on completion or dispose.
 */

export interface ExportItem {
  id: string
  source: string
  start: number
  end: number
}

export interface ExportApi {
  detectEncoders(): Promise<string[]>
  openh264Status(): Promise<{ installed: boolean }>
  downloadOpenH264(): Promise<string>
  selectOutDir(): Promise<string | null>
  openFolder(dir: string): Promise<boolean>
  start(opts: unknown): Promise<StartResult>
  cancel(): Promise<{ cancelled: boolean }>
/** Check that the output directory exists and is writable before starting. */
  checkOutDir(dir: string): Promise<{ ok: true } | { ok: false; reason: string }>
  diskSpace(dir: string): Promise<{ freeBytes: number; totalBytes: number }>
  onProgress(cb: (data: unknown) => void): () => void
  onOpenH264Progress(cb: (ratio: number) => void): () => void
}

type StartResult =
  | { ok: true; outputs: string[]; notices?: string[] }
  | { ok: false; cancelled: true; outputs: string[]; notices?: string[] }
  | { ok: false; cancelled?: false; error: string; outputs: string[]; notices?: string[] }

export type ExportPhase = 'settings' | 'running' | 'done' | 'failed'

export interface ExportSettings {
  mode: 'concat' | 'separate'
  quality: 'copy' | 'precise'
/** Encoder actually sent to main (derived from encoderChoice and detection results). */
  encoder: string
/** User choice: 'auto' uses priority order; otherwise, the name of a detected available encoder. */
  encoderChoice: string
  outDir: string | null
  baseName: string
}

export interface ExportProgress {
  percent: number
  jobIndex: number
  totalJobs: number
  outTimeSeconds: number
}

export interface ExportResult {
  ok: boolean
  cancelled: boolean
  outputs: string[]
  notices: string[]
/** Tail of ffmpeg stderr on failure (or a validation error message). */
  error: string | null
  durationMs: number
}

export interface OpenH264State {
  step: 'idle' | 'consent' | 'downloading' | 'error'
  ratio: number
  error: string | null
}

export interface ExportState {
  phase: ExportPhase
  settings: ExportSettings
  encoders: string[]
  openh264Installed: boolean
  detected: boolean
  disk: { freeBytes: number; totalBytes: number } | null
  outDirError: string | null
  progress: ExportProgress | null
  result: ExportResult | null
  h264: OpenH264State
}

const ENCODER_PRIORITY = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264']
export const ENCODER_AUTO = 'auto'

function pickEncoder(encoders: string[]): string {
  for (const e of ENCODER_PRIORITY) if (encoders.includes(e)) return e
  return encoders[0] ?? ''
}

/** For 'auto' or an unavailable choice, select by priority; otherwise use the encoder selected by the user. */
function resolveEncoder(choice: string, encoders: string[]): { choice: string; encoder: string } {
  if (choice !== ENCODER_AUTO && encoders.includes(choice)) return { choice, encoder: choice }
  return { choice: ENCODER_AUTO, encoder: pickEncoder(encoders) }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createExportController(api: ExportApi, initialName = 'highlight') {
  let state: ExportState = {
    phase: 'settings',
    settings: { mode: 'concat', quality: 'copy', encoder: '', encoderChoice: ENCODER_AUTO, outDir: null, baseName: initialName },
    encoders: [],
    openh264Installed: false,
    detected: false,
    disk: null,
    outDirError: null,
    progress: null,
    result: null,
    h264: { step: 'idle', ratio: 0, error: null }
  }
  const listeners = new Set<() => void>()
  let lastItems: ExportItem[] | null = null
  let offProgress: (() => void) | null = null
  let offH264: (() => void) | null = null

  function set(patch: Partial<ExportState>): void {
    state = { ...state, ...patch }
    for (const l of [...listeners]) l()
  }
  const setSettings = (patch: Partial<ExportSettings>): void => set({ settings: { ...state.settings, ...patch } })

  async function refreshDisk(dir: string | null): Promise<void> {
    if (!dir) {
      set({ disk: null, outDirError: i18n.export.blockNoOutDir })
      return
    }
    // Verify the directory exists and is writable first: an invalid directory blocks in Settings rather than failing only after Start is pressed.
    try {
      const check = await api.checkOutDir(dir)
      if (!check.ok) {
        set({ disk: null, outDirError: tr('{label}（{detail}）', { label: i18n.export.blockOutDirInvalid, detail: check.reason }) })
        return
      }
    } catch (e) {
      set({ disk: null, outDirError: tr('{label}（{detail}）', { label: i18n.export.blockOutDirInvalid, detail: errMsg(e) }) })
      return
    }
    try {
      const d = await api.diskSpace(dir)
      set({ disk: d, outDirError: null })
    } catch (e) {
      set({ disk: null, outDirError: tr('{label}（{detail}）', { label: i18n.export.blockOutDirInvalid, detail: errMsg(e) }) })
    }
  }

  async function detect(): Promise<void> {
    let encoders: string[] = []
    let installed = false
    try {
      encoders = (await api.detectEncoders()) ?? []
    } catch {
      encoders = []
    }
    try {
      installed = !!(await api.openh264Status())?.installed
    } catch {
      installed = false
    }
    const r = resolveEncoder(state.settings.encoderChoice, encoders)
    set({
      encoders,
      openh264Installed: installed,
      detected: true,
      settings: { ...state.settings, encoder: r.encoder, encoderChoice: r.choice }
    })
  }

  async function init(defaultOutDir: string | null): Promise<void> {
    setSettings({ outDir: defaultOutDir })
    await Promise.all([detect(), refreshDisk(defaultOutDir)])
  }

  const needsConsent = (): boolean => state.encoders.length === 0 && !state.openh264Installed

  async function setQuality(q: 'copy' | 'precise'): Promise<void> {
    setSettings({ quality: q })
    if (q === 'precise' && needsConsent()) set({ h264: { step: 'consent', ratio: 0, error: null } })
  }

  function declineConsent(): void {
    setSettings({ quality: 'copy' })
    set({ h264: { step: 'idle', ratio: 0, error: null } })
  }

  async function acceptConsent(): Promise<void> {
    if (state.h264.step === 'downloading') return
    set({ h264: { step: 'downloading', ratio: 0, error: null } })
    offH264 = api.onOpenH264Progress((r) => {
      if (state.h264.step === 'downloading') set({ h264: { step: 'downloading', ratio: r, error: null } })
    })
    try {
      await api.downloadOpenH264()
    } catch (e) {
      offH264?.()
      offH264 = null
        setSettings({ quality: 'copy' })
      set({ h264: { step: 'error', ratio: 0, error: errMsg(e) } })
      return
    }
    offH264?.()
    offH264 = null
    await detect()
    if (state.encoders.includes('libopenh264')) {
      setSettings({ encoder: 'libopenh264', encoderChoice: 'libopenh264', quality: 'precise' })
      set({ h264: { step: 'idle', ratio: 1, error: null } })
    } else {
      setSettings({ quality: 'copy' })
      set({ h264: { step: 'error', ratio: 0, error: i18n.export.h264NotDetected } })
    }
  }

  async function chooseOutDir(): Promise<void> {
    let dir: string | null = null
    try {
      dir = await api.selectOutDir()
    } catch {
      dir = null
    }
    if (!dir) return
    setSettings({ outDir: dir })
    await refreshDisk(dir)
  }

  async function start(items: ExportItem[]): Promise<void> {
    if (state.phase === 'running') return
    const s = state.settings
    if (!s.outDir) {
      set({ outDirError: i18n.export.blockNoOutDir })
      return
    }
    if (state.outDirError) return // Output-directory validation failed; use the same condition as the disabled button and do not send export:start.
    lastItems = items
    const startedAt = Date.now()
    set({ phase: 'running', progress: { percent: 0, jobIndex: 0, totalJobs: 1, outTimeSeconds: 0 }, result: null })
    offProgress = api.onProgress((d) => {
      const p = d as Partial<ExportProgress> | null
      if (!p || typeof p.percent !== 'number') return
      set({
        progress: {
          percent: p.percent,
          jobIndex: p.jobIndex ?? 0,
          totalJobs: p.totalJobs ?? 1,
          outTimeSeconds: p.outTimeSeconds ?? 0
        }
      })
    })
    let res: StartResult
    try {
      res = await api.start({
        items,
        mode: s.mode,
        quality: s.quality,
        encoder: s.encoder || undefined,
        outDir: s.outDir,
        baseName: s.baseName
      })
    } catch (e) {
      res = { ok: false, error: errMsg(e), outputs: [] }
    } finally {
      offProgress?.()
      offProgress = null
    }
    const durationMs = Date.now() - startedAt
    const notices = res.notices ?? []
    if (res.ok) {
      set({ phase: 'done', result: { ok: true, cancelled: false, outputs: res.outputs, notices, error: null, durationMs } })
    } else if (res.cancelled) {
      set({ phase: 'done', result: { ok: false, cancelled: true, outputs: res.outputs, notices, error: null, durationMs } })
    } else {
      set({ phase: 'failed', result: { ok: false, cancelled: false, outputs: res.outputs, notices, error: res.error, durationMs } })
    }
  }

  async function cancel(): Promise<void> {
    if (state.phase !== 'running') return
    try {
      await api.cancel()
    } catch {
      // If cancellation fails, export will end naturally and start() will report the result.
    }
  }

  function retry(): Promise<void> {
    if (!lastItems) return Promise.resolve()
    set({ phase: 'settings' })
    return start(lastItems)
  }

  /** Actual output directory: mode-specific subfolder (Merged/Clips) under the user's outDir; null when outDir is empty. */
  function getOutputDir(): string | null {
    const { outDir, mode } = state.settings
    return outDir ? joinForDisplay(outDir, exportSubDirName(mode)) : null
  }

  async function openFolder(): Promise<void> {
    const dir = getOutputDir()
    if (!dir) return
    try {
      await api.openFolder(dir)
    } catch {
      // Failure to open the folder does not affect the export result.
    }
  }

  /** Return to Settings after completion or failure. */
  function finish(): void {
    if (state.phase === 'running') return
    set({ phase: 'settings', result: null, progress: null })
    void refreshDisk(state.settings.outDir)
  }

  function dispose(opts: { cancelIfRunning?: boolean } = {}): void {
    if (opts.cancelIfRunning && state.phase === 'running') void api.cancel().catch(() => undefined)
    offProgress?.()
    offProgress = null
    offH264?.()
    offH264 = null
  }

  return {
    getState: (): ExportState => state,
    getOutputDir,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    init,
    setMode: (mode: ExportSettings['mode']): void => setSettings({ mode }),
    setQuality,
/** 'auto' or a detected available encoder; ignore unavailable names. */
    setEncoder: (choice: string): void => {
      if (choice !== ENCODER_AUTO && !state.encoders.includes(choice)) return
      const r = resolveEncoder(choice, state.encoders)
      setSettings({ encoder: r.encoder, encoderChoice: r.choice })
    },
    redetect: detect,
    setBaseName: (baseName: string): void => setSettings({ baseName }),
    chooseOutDir,
    openFolder,
    declineConsent,
    acceptConsent,
    start,
    cancel,
    retry,
    finish,
    dispose
  }
}

export type ExportController = ReturnType<typeof createExportController>
