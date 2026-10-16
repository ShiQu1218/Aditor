// 首次啟動的低效能詢問：偵測無硬體解碼 1080p60 H.264 時，顯示一次非模態通知。
import type { Settings } from '../../shared/settings'

/** 探測設定：1080p60 H.264（應用程式最常見的錄影格式） */
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

/** 無硬體解碼（不支援、不流暢或非省電＝軟體解碼）→ true。API 不存在或失敗 → false（不打擾使用者）。 */
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
 * 狀態機：start() 於啟動時呼叫一次。從未詢問過、尚未開啟低效能模式且無硬體解碼 → 顯示通知，
 * 並立刻記下 `lowPerfAsked`（無論使用者之後怎麼回應，只問一次）。
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
        /* 偵測／讀設定失敗＝不詢問 */
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
