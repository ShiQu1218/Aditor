// First-launch low-performance prompt: show one non-modal notice when hardware decoding for 1080p60 H.264 is unavailable.
import type { Settings } from '../../shared/settings'

/** Probe settings: 1080p60 H.264 (the app's most common recording format). */
export const PROBE_CONFIG = {
  type: 'file' as const,
  video: {
    contentType: 'video/mp4; codecs="avc1.640028"',
    width: 1920,
    height: 1080,
    bitrate: 20_000_000,
    framerate: 60
  }
}

interface MediaCapabilitiesLike {
  decodingInfo(config: typeof PROBE_CONFIG): Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }>
}

/** Return true without hardware decoding (unsupported, not smooth, or not power-efficient means software decoding). Return false if the API is missing or fails (do not bother the user). */
export async function lacksHardwareDecode(mc: MediaCapabilitiesLike | undefined): Promise<boolean> {
  if (!mc?.decodingInfo) return false
  try {
    const r = await mc.decodingInfo(PROBE_CONFIG)
    return !(r.supported && r.smooth && r.powerEfficient)
  } catch {
    return false
  }
}

export interface PromptDeps {
  getSettings: () => Promise<Pick<Settings, 'lowPerfAsked' | 'lowPerfMode'>>
  setSettings: (partial: Partial<Settings>) => Promise<unknown>
  mediaCapabilities: MediaCapabilitiesLike | undefined
}

export interface LowPerfPrompt {
  start(): Promise<void>
  accept(): Promise<void>
  dismiss(): Promise<void>
}

/**
 * State machine: call start() once at startup. If the user has never been asked, low-performance mode is off, and hardware decoding is unavailable, show the notice
 * and immediately set `lowPerfAsked` (ask only once, regardless of the user's response).
 */
export function createLowPerfPrompt(deps: PromptDeps, onVisible: (visible: boolean) => void): LowPerfPrompt {
  return {
    async start() {
      try {
        const s = await deps.getSettings()
        if (s.lowPerfAsked || s.lowPerfMode) return
        if (!(await lacksHardwareDecode(deps.mediaCapabilities))) return
        await deps.setSettings({ lowPerfAsked: true })
        onVisible(true)
      } catch {
        /* If detection or settings read fails, skip the prompt. */
      }
    },
    async accept() {
      onVisible(false)
      await deps.setSettings({ lowPerfMode: true, lowPerfAsked: true })
    },
    async dismiss() {
      onVisible(false)
    }
  }
}
