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
  playability: PlayabilityResult
  /** 代理檔狀態：none＝未產生（才會建議）、available＝已有、generating＝產生中（進度由 UI 顯示） */
  proxyState: 'none' | 'available' | 'generating'
  /** 引擎錯誤代碼（顯示於文案） */
  errorCode?: string | number
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
  if (input.proxyState === 'none') {
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
  return null
}

/** 代理檔產生中的狀態列：有進度（0–1）顯示百分比，否則通用文字。 */
export function proxyBusyNotice(ratio: number | null): StudioNotice {
  const t = i18n.studio.notices
  const title =
    ratio === null ? t.proxyBusy : t.proxyGenerating.replace('{n}', String(Math.round(Math.max(0, Math.min(1, ratio)) * 100)))
  return { id: 'proxy-generating', kind: 'info', title, text: '', actions: [] }
}
