import React, { useEffect } from 'react'
import { recordedTime } from '../library/recordedTime'
import { i18n } from '../i18n/zh-TW'
import { StudioLoadingView } from './StudioStates'
import { useStudioLibrary } from './useStudioLibrary'
import '../styles/studio.css'

/** 尚未選片時，直接進入最新錄影；空影片庫保留在工作室。 */
export function StudioLanding({ onOpenVideo, onBack }: { onOpenVideo: (path: string) => void; onBack: () => void }): JSX.Element {
  const { entries, failed, retry } = useStudioLibrary()
  const newest = entries?.reduce<(typeof entries)[number] | undefined>((best, entry) =>
    !best || recordedTime(entry) > recordedTime(best) ? entry : best, undefined)
  useEffect(() => {
    if (newest && !failed) onOpenVideo(newest.path)
  }, [newest, failed, onOpenVideo])
  if (!entries && !failed) return <StudioLoadingView />
  return (
    <div className="studio-blocked" role={failed ? 'alert' : 'status'}>
      <p>{failed ? i18n.studio.libraryReadFailed : newest ? i18n.studio.loading : i18n.studio.empty}</p>
      {failed && <button type="button" className="btn-accent" onClick={retry}>{i18n.studio.loadFailed.retry}</button>}
      <button type="button" className="btn-ghost" onClick={onBack}>{i18n.studio.back}</button>
    </div>
  )
}
