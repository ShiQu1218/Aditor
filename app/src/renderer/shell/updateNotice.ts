import type { UpdateStatus } from '../../shared/update'

/** What the rail update button shows: a newer version, an update that failed, or nothing. */
export type UpdateNotice = { kind: 'available'; version: string } | { kind: 'failed' } | null

/**
 * Map an update status to the rail notice. Available/downloading/downloaded with a version shows the
 * update. An update that failed stays visible only when a newer version was seen in this session, so
 * a failed check with no known update does not add a button.
 */
export function updateNoticeFor(status: UpdateStatus, seenVersion: string | null): UpdateNotice {
  if ((status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded') && status.version) {
    return { kind: 'available', version: status.version }
  }
  if (status.state === 'error' && seenVersion !== null) return { kind: 'failed' }
  return null
}
