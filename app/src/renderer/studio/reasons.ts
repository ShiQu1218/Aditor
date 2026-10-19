import type { EngineEvent } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n'
import { tr } from '../../shared/locale'

/**
 * 事件原因小字（spec §3.2.3）：軟刪除 → 強制（override）→ counted_reason；
 * 未知的 counted_reason 原樣顯示（向前相容引擎新增值）。
 */
export function eventReason(e: EngineEvent): string {
  const t = i18n.studio.eventReasons
  if (e.deleted) return t.reasonDeleted
  if (e.counted_override === true) return t.reasonForced
  if (e.counted_override === false) return t.reasonForcedOff
  const reasons = i18n.timeline.reasons as Record<string, string>
  return reasons[e.counted_reason] ?? e.counted_reason ?? ''
}

/** 列 aria-label：「擊倒 5:32 計入」／「擊倒 5:32 不計入：觀戰中」。 */
export function eventAriaLabel(e: EngineEvent): string {
  const types = i18n.timeline.types as Record<string, string>
  const type = types[e.type] ?? e.type
  const state = isCounted(e) ? i18n.timeline.counted : tr('{label}：{detail}', { label: i18n.timeline.uncounted, detail: eventReason(e) })
  return `${type} ${formatTime(e.t)} ${state}`
}
