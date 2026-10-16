import type { PlayabilityResult } from '../media/playability'
import { i18n } from '../i18n/zh-TW'

export type NoticeAction = 'resume' | 'copyError' | 'generateProxy' | 'later' | 'relink' | 'back'

export interface StudioNotice {
  id: string
  kind: 'error' | 'warn' | 'info'
  title: string
  text: string
  actions: NoticeAction[]
}

export interface StudioNoticeInput {
  analysis: 'done' | 'error'
  /** 影片檔案找不到或無法播放（來源模式 `<video>` 載入失敗） */
  videoMissing?: boolean
  playability: PlayabilityResult
  /** 代理檔狀態：none＝未產生（才會建議）、available＝已有、generating＝產生中（進度由 UI 顯示） */
  proxyState: 'none' | 'available' | 'generating'
  /** 引擎錯誤代碼（顯示於文案） */
  errorCode?: string | number
  /** 設定「建議代理檔」：false 時不建議（預設 true） */
  proxySuggest?: boolean
  /** 分析結果的語言偵測：false＝自動偵測失敗（優先顯示）；undefined＝舊快取，不提示 */
  langDetected?: boolean
  /** 該語言是否支援觀戰偵測：false＝提示無法自動排除觀戰 */
  spectatingSupported?: boolean | null
}

/**
 * 工作室頂部 notice 的純函式（spec §3.2.6）：
 * 引擎異常 → 錯誤＋〔接續分析〕；非可播放／無硬體解碼且尚無代理檔 → 代理檔建議；其餘 null。
 */
export function studioNotice(input: StudioNoticeInput): StudioNotice | null {
  const t = i18n.studio.notices
  if (input.analysis === 'error') {
    return {
      id: 'engine-error',
      kind: 'error',
      title: t.engineErrorTitle,
      text: t.engineErrorText.replace('{code}', String(input.errorCode ?? 'unknown')),
      actions: ['resume', 'copyError']
    }
  }
  if (input.videoMissing) {
    return {
      id: 'video-missing',
      kind: 'error',
      title: t.videoMissingTitle,
      text: t.videoMissingText,
      actions: ['relink', 'back']
    }
  }
  if (input.langDetected === false) {
    return {
      id: 'lang-undetermined',
      kind: 'warn',
      title: t.langUndeterminedTitle,
      text: t.langUndeterminedText,
      actions: ['back']
    }
  }
  if (input.proxyState === 'none' && input.proxySuggest !== false) {
    const p = input.playability
    if (!p.supported || !p.smooth || !p.powerEfficient) {
      return {
        id: 'proxy-suggest',
        kind: 'warn',
        title: t.proxyTitle,
        text: t.proxyText,
        actions: ['generateProxy', 'later']
      }
    }
  }
  if (input.spectatingSupported === false) {
    return {
      id: 'spectating-unsupported',
      kind: 'info',
      title: t.spectatingUnsupportedTitle,
      text: t.spectatingUnsupportedText,
      actions: []
    }
  }
  return null
}

/** 代理檔產生中的狀態列：有進度（0–1）顯示百分比，否則通用文字。 */
export function proxyBusyNotice(ratio: number | null): StudioNotice {
  const t = i18n.studio.notices
  const title =
    ratio === null ? t.proxyBusy : t.proxyGenerating.replace('{n}', String(Math.round(Math.max(0, Math.min(1, ratio)) * 100)))
  return { id: 'proxy-generating', kind: 'info', title, text: '', actions: [] }
}
