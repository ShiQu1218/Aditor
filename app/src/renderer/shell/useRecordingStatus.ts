import { useCallback, useEffect, useRef, useState } from 'react'
import { IDLE_RECORDING_STATUS, type RecordingStatus } from '../../shared/recording'
import { recordingI18n } from '../i18n'

/** 先訂閱再讀快照，避免較慢的初始回覆蓋過新推播。 */
export function useRecordingStatus(): { status: RecordingStatus; error: string | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<RecordingStatus>(IDLE_RECORDING_STATUS)
  const [error, setError] = useState<string | null>(null)
  const revision = useRef(0)
  const active = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    const version = ++revision.current
    try {
      const api = window.api?.recording
      if (!api) throw new Error('錄影服務未連接')
      const next = await api.getStatus()
      if (active.current && revision.current === version) {
        setStatus(next)
        setError(null)
      }
    } catch {
      if (active.current && revision.current === version) setError(recordingI18n.serviceUnavailable)
    }
  }, [])
  useEffect(() => {
    active.current = true
    const off = window.api?.recording?.onStatus((next) => {
      revision.current += 1
      setStatus(next)
      setError(null)
    })
    void refresh()
    return () => {
      active.current = false
      revision.current += 1
      off?.()
    }
  }, [refresh])
  return { status, error, refresh }
}
