import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../shared/update'
import { updateNoticeFor, type UpdateNotice } from './updateNotice'

interface UpdateSnapshot {
  status: UpdateStatus
  /** Last newer version seen in this session, kept so a failed download can still surface in the rail. */
  seenVersion: string | null
}

/** Subscribe before reading the snapshot so a slower initial response cannot overwrite a newer push. */
function useUpdateSnapshot(): UpdateSnapshot {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot>({ status: { state: 'idle' }, seenVersion: null })
  useEffect(() => {
    const api = window.api?.update
    if (!api) return
    let active = true
    let pushed = false
    const apply = (next: UpdateStatus): void => {
      setSnapshot((prev) => ({ status: next, seenVersion: next.version ?? prev.seenVersion }))
    }
    const off: () => void = api.onStatus((next: UpdateStatus) => {
      pushed = true
      apply(next)
    })
    api.getStatus().then(
      (snapshot: UpdateStatus) => {
        if (active && !pushed) apply(snapshot)
      },
      () => {
        // Keep the idle display if the status cannot be read.
      }
    )
    return () => {
      active = false
      off()
    }
  }, [])
  return snapshot
}

export function useUpdateStatus(): UpdateStatus {
  return useUpdateSnapshot().status
}

/** Rail notice for the current update status. */
export function useUpdateNotice(): UpdateNotice {
  const { status, seenVersion } = useUpdateSnapshot()
  return updateNoticeFor(status, seenVersion)
}
