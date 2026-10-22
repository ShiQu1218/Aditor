import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../shared/update'

/** Subscribe before reading the snapshot so a slower initial response cannot overwrite a newer push. */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    const api = window.api?.update
    if (!api) return
    let active = true
    let pushed = false
    const off: () => void = api.onStatus((next: UpdateStatus) => {
      pushed = true
      setStatus(next)
    })
    api.getStatus().then(
      (snapshot: UpdateStatus) => {
        if (active && !pushed) setStatus(snapshot)
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
  return status
}
