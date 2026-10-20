import type { EngineEvent } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n'
import { tr } from '../../shared/locale'

/**
 * Event-reason caption (spec §3.2.3): soft deletion → forced override → counted_reason;
 * show unknown counted_reason values unchanged for forward compatibility with new engine values.
 */
export function eventReason(e: EngineEvent): string {
  const t = i18n.studio.eventReasons
  if (e.deleted) return t.reasonDeleted
  if (e.counted_override === true) return t.reasonForced
  if (e.counted_override === false) return t.reasonForcedOff
  const reasons = i18n.timeline.reasons as Record<string, string>
  return reasons[e.counted_reason] ?? e.counted_reason ?? ''
}

/** Row aria-label, e.g. "Knock at 5:32 included" or "Knock at 5:32 excluded: spectating." */
export function eventAriaLabel(e: EngineEvent): string {
  const types = i18n.timeline.types as Record<string, string>
  const type = types[e.type] ?? e.type
  const state = isCounted(e) ? i18n.timeline.counted : tr('{label}：{detail}', { label: i18n.timeline.uncounted, detail: eventReason(e) })
  return `${type} ${formatTime(e.t)} ${state}`
}
