import { useEffect, useRef, type MutableRefObject } from 'react'
import type { CacheDoc } from '../../shared/types'
import type { Project } from '../editor/project'
import { drawerFixtureRequested } from '../dev/fixture'
import { i18n } from '../i18n'
import type { useToast } from '../shell/ToastHost'
import type { createExportController, ExportState } from './exportController'
import { buildPlanBase, ExportPlanBase } from './exportPlanBase'

interface StudioExportOptions {
  exportCtl: ReturnType<typeof createExportController>
  exportState: ExportState
  exportOpen: boolean
  exportOpenRef: MutableRefObject<boolean>
  setExportOpen: (open: boolean) => void
  setExportBase: (base: ExportPlanBase) => void
  handleOpenExport: () => void
  project: Project
  projectRef: MutableRefObject<Project>
  missingItemIds: ReadonlySet<string>
  doc: CacheDoc
  videoPath: string
  loaded: boolean
  toast: ReturnType<typeof useToast>
}

/** Export drawer side effects: plan-base collection, the minimized completion Toast, and the dev drawer fixture. */
export function useStudioExport({
  exportCtl,
  exportState,
  exportOpen,
  exportOpenRef,
  setExportOpen,
  setExportBase,
  handleOpenExport,
  project,
  projectRef,
  missingItemIds,
  doc,
  videoPath,
  loaded,
  toast
}: StudioExportOptions): void {
  // While the drawer is in settings, recollect source properties when the project, missing sources, or current-video info changes; the project track remains editable.
  useEffect(() => {
    if (!exportOpen || exportState.phase !== 'settings') return
    let cancelled = false
    void buildPlanBase(
      project,
      missingItemIds,
      { path: videoPath, info: { codec: doc.video.codec, width: doc.video.width, height: doc.video.height, fps: doc.video.fps, pix_fmt: doc.video.pix_fmt }, keyframes: doc.keyframes ?? [] },
      async (src) => (await window.api?.engine?.probe?.(src)) ?? null
    ).then((b) => {
      if (!cancelled) setExportBase(b)
    })
    return () => {
      cancelled = true
    }
  }, [exportOpen, exportState.phase, project, missingItemIds, doc, videoPath])

  // If export finishes while the drawer is minimized, show a Toast with a View action.
  const prevPhaseRef = useRef(exportState.phase)
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = exportState.phase
    if (prev !== 'running' || exportState.phase === 'running' || exportOpenRef.current) return
    const t = i18n.export
    toast({
      message: exportState.phase === 'failed' ? t.toastFailed : exportState.result?.cancelled ? t.toastCancelled : t.toastDone,
      action: { label: t.view, run: () => setExportOpen(true) }
    })
  }, [exportState.phase, exportState.result, toast])

  // Development only: ?drawer=… loads fake IPC to show drawer states directly for screenshots; dynamically imported and excluded from production bundles.
  const drawerFixtureDone = useRef(false)
  useEffect(() => {
    const kind = import.meta.env.DEV ? drawerFixtureRequested() : null
    if (!kind || drawerFixtureDone.current) return
    drawerFixtureDone.current = true
    void import('../dev/exportFixture').then(async (m) => {
      m.installExportFixtureApi(kind)
      handleOpenExport()
      await new Promise((r) => setTimeout(r, 150))
      if (kind === 'consent') await exportCtl.setQuality('precise')
      else if (kind !== 'settings') {
        const items = projectRef.current.items.map((i) => ({ id: i.id, source: i.source, start: i.start, end: i.end }))
        void exportCtl.start(items)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])
}
