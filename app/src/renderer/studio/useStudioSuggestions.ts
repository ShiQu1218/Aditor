import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import type { Clip } from '../../shared/types'
import type { ViewerAction, ViewerState } from '../viewer/state'
import { applyAutoClip, clipAt, isSuggestionsPending, mergeSuggestions, nextSuggestion, planSuggestions } from './highlights'
import type { StudioSettings } from './studioSettings'

interface StudioSuggestionsOptions {
  settings: StudioSettings | null
  state: ViewerState
  dispatch: Dispatch<ViewerAction>
  analysisGen: number
  duration: number
  shownClips: Clip[]
  currentTime: number
  setActiveClipId: Dispatch<SetStateAction<string | null>>
}

/** AI suggestions after each analysis generation, the active highlight card, and popover results. */
export function useStudioSuggestions({
  settings,
  state,
  dispatch,
  analysisGen,
  duration,
  shownClips,
  currentTime,
  setActiveClipId
}: StudioSuggestionsOptions): { handleApplyAutoClip: (clips: Clip[]) => void } {
  // Latest clip snapshot (suggestion merging runs after await and must not capture stale values).
  const clipsRef = useRef(state.clips)
  clipsRef.current = state.clips

  const handledGen = useRef(0)
  /** Suggestion request sequence: discard older responses after the user applies the popover or starts a newer request. */
  const suggestSeq = useRef(0)

  // Suggestions after analysis (spec §3.2.6, §4.2): engine documents contain manual clips only, so
  // - on load, if there are no AI clips and the setting is enabled, place suggestions automatically;
  // - on reanalysis of a video with AI clips, rerun autoclip with default parameters and merge via mergeOnReanalyze
  //   (keep added clips as stale, discard old suggestions/skips, and add new suggestions).
  // Run once per analysis generation; do not call when the engine is unavailable.
  useEffect(() => {
    if (!settings || analysisGen === 0 || handledGen.current === analysisGen) return
    handledGen.current = analysisGen
    // The app.suggestionsPending document flag determines whether this is a reanalysis (main writes it afterward); on a fresh studio mount,
    // there are no clips in state to distinguish reanalysis from first load.
    const plan = planSuggestions({ doc: state.doc, clips: clipsRef.current, settings })
    if (plan.kind === 'none') {
      // Even when no suggestions can be made (for example, no events), clear the flag so every open is not treated as pending.
      if (isSuggestionsPending(state.doc) && state.doc.analysis?.status === 'done') {
        dispatch({ type: 'applySuggestions', clips: clipsRef.current })
      }
      return
    }
    const api = window.api
    if (!api?.engine?.autoclip) return
    const seq = ++suggestSeq.current
    const events = state.doc.events
    void (async () => {
      try {
        const res = await api.engine.autoclip({ events, params: plan.params, duration })
        if (seq !== suggestSeq.current) return // The user applied the popover or started a newer request in the meantime.
        const fresh: Clip[] = Array.isArray(res?.clips) ? res.clips : []
        if (plan.kind === 'place' && fresh.length === 0) return
        // After applying, clear the flag and save so the same reanalysis merges only once and later user skips are not overwritten.
        // Keep the flag when autoclip fails so it can retry on the next open.
        dispatch({ type: 'applySuggestions', clips: mergeSuggestions(plan.kind, clipsRef.current, fresh) })
      } catch (err) {
        console.error('Failed to place AI suggestions:', err)
      }
    })()
  }, [settings, state.doc, analysisGen, duration])

  // Ensure a card is active when the highlights tab opens (the first roving-tabindex stop).
  useEffect(() => {
    setActiveClipId((prev) =>
      prev && shownClips.some((c) => c.id === prev) ? prev : nextSuggestion(shownClips, null, 1)
    )
  }, [shownClips])

  // When the playhead enters a highlight's range, make that card active so the sidebar points at it;
  // react only to entering a new range so manual card selection outside highlights is left alone.
  const clipUnderPlayhead = useMemo(() => clipAt(shownClips, currentTime), [shownClips, currentTime])
  useEffect(() => {
    if (clipUnderPlayhead) setActiveClipId(clipUnderPlayhead)
  }, [clipUnderPlayhead])

  /** Apply popover results: replace only suggested AI clips (keep added, skipped, and manual clips) and write to cache. */
  const handleApplyAutoClip = useCallback(
    (clips: Clip[]) => {
      suggestSeq.current++ // Pending automatic suggestions must not overwrite the result the user just applied.
      dispatch({ type: 'applyClips', clips: applyAutoClip(clipsRef.current, clips) })
    },
    []
  )

  return { handleApplyAutoClip }
}
