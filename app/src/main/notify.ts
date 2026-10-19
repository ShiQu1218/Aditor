import { Notification } from 'electron'
import type { RecordingSettings } from '../shared/recording'
import type { RecordingNoticeKind } from './recording'

interface Notice {
  once(event: 'close' | 'failed', listener: () => void): unknown
  show(): void
}

interface NotificationDependencies {
  isSupported: () => boolean
  create: (options: { title: string; body: string; silent?: boolean; urgency?: 'low' }) => Notice
}

/** 通知失敗不能中斷錄影或讓已完成的收尾被當成失敗。 */
export function createRecordingNotifier(
  getSettings: () => RecordingSettings,
  deps: NotificationDependencies = {
    isSupported: () => Notification.isSupported(),
    create: (options) => new Notification(options)
  }
): (kind: RecordingNoticeKind, message: string) => void {
  const active = new Set<Notice>()
  return (kind, message) => {
    if ((kind === 'matchStart' || kind === 'matchEnd') && !getSettings().notifyMatch) return
    try {
      if (!deps.isSupported()) return
      const notice = deps.create({ title: 'Apex Highlighter', body: message, ...(kind === 'matchCancel' ? { silent: true, urgency: 'low' as const } : {}) })
      active.add(notice)
      notice.once('close', () => active.delete(notice))
      notice.once('failed', () => {
        active.delete(notice)
        console.error('無法顯示錄影通知：', message)
      })
      try { notice.show() }
      catch (error) { active.delete(notice); throw error }
    } catch (error) {
      console.error('無法顯示錄影通知：', error)
    }
  }
}
