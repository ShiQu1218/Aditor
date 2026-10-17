import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import '../styles/studio.css'
import '../styles/projectTrack.css'
import { CacheDoc, Clip, EventType } from '../../shared/types'
import { formatTime, toCurrentTime } from '../../shared/time'
import { viewerReducer, ViewerState } from '../viewer/state'
import { leadInSeek, STUDIO_SETTINGS_DEFAULTS, subscribeStudioSettings, type StudioSettings } from './studioSettings'
import { nextEvent } from '../timeline/model'
import { TimelineCanvas, TimelineHandle } from '../timeline/TimelineCanvas'
import { useKeymap } from '../hooks/useShortcuts'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useToast } from '../shell/ToastHost'
import { useOverlay } from '../shell/OverlayHost'
import { useProject } from '../editor/ProjectProvider'
import { importExternalVideos } from '../editor/externalVideos'
import { addItems, duplicateItem, moveItem, Project, ProjectItem, removeItem, splitItem, trimItem } from '../editor/project'
import { nextAfter, nextPlayableItem } from '../editor/sequence'
import { ExportDrawer } from './ExportDrawer'
import { createExportController } from './exportController'
import { windowExportApi } from './exportApi'
import { buildPlanBase, ExportPlanBase } from './exportPlanBase'
import { useEditorLock } from '../editor/useEditorLock'
import { checkSmooth, PlayabilityResult } from '../media/playability'
import { Command } from '../input/keymap'
import { drawerFixtureRequested, longFixtureRequested } from '../dev/fixture'
import { i18n } from '../i18n/zh-TW'
import { AddEventDialog } from './AddEventDialog'
import { Aside } from './Aside'
import { AutoClipPopover } from './AutoClipPopover'
import { ContextBanner } from './ContextBanner'
import {
  acceptToProject,
  applyAutoClip,
  clipTitle,
  findItemsForClip,
  isSuggested,
  mergeSuggestions,
  nextSuggestion,
  planAccept,
  planAddAll,
  isSuggestionsPending,
  planSuggestions,
  removeProjectItems
} from './highlights'
import { HighlightsTab } from './HighlightsTab'
import { NoticeBar } from './NoticeBar'
import { PlayerStage } from './PlayerStage'
import { ProjectTrack } from './ProjectTrack'
import { StudioHeader } from './StudioHeader'
import { StudioBlockedView, StudioLoadErrorView, StudioLoadingView } from './StudioStates'
import { TransportBar } from './TransportBar'
import { chipCounts, nearCount, toggleFilter } from './chips'
import { createMode, currentItem, reconcileMode, reduceMode } from './mode'
import { NoticeAction, proxyBusyNotice, studioNotice, StudioNotice } from './notices'
import { createAnnouncer } from './liveAnnouncer'
import { guardCommand, SourceEditCommand } from './modeGuard'
import { eventAriaLabel } from './reasons'
import { AutosaveController } from '../editor/useAutosave'
import { navReference, type NavAnchor } from './eventNav'
import { isAnyOverlayOpen, OverlayState, topOverlay } from './overlays'
import { fileUrl, onVideoError, planSeek, routeTimeUpdate } from './seekPlan'
import { loadStudioDoc } from './studioLoader'

export interface ProjectPlaybackRequest {
  playItemId: string
  speed: number
}

interface StudioScreenProps {
  videoPath: string
  onBack: () => void
  onOpenVideo: (path: string, request: ProjectPlaybackRequest) => void
  playbackRequest?: ProjectPlaybackRequest
  onPlaybackRequestConsumed?: () => void
  /** 測試接縫：直接給定已載入的文件（略過載入流程；SSR 冒煙測試用） */
  preloadedDoc?: CacheDoc
}

const DEFAULT_FILTER = new Set<EventType>(['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe'])
const DEFAULT_PLAYABILITY: PlayabilityResult = { supported: true, smooth: true, powerEfficient: true }

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

/** 路徑正規化（來源比對：片段是否屬於目前開啟的影片）。 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function initialDoc(videoPath: string): CacheDoc {
  return {
    version: 1,
    video: {
      path: videoPath,
      size: 0,
      mtime: 0,
      duration: 100,
      width: 1920,
      height: 1080,
      codec: 'h264',
      start_time: 0
    },
    analysis: {
      status: 'done',
      progress_t: 0,
      engine_version: '0.1.0',
      templates_version: 'icons@1',
      h_scale: 1.0
    },
    events: [],
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: ''
  }
}

function initViewerState(init: { videoPath: string; doc?: CacheDoc }): ViewerState {
  return {
    doc: init.doc ?? initialDoc(init.videoPath),
    filter: new Set(DEFAULT_FILTER),
    clips: [],
    dirty: false
  }
}

/**
 * 工作室（spec §3.2）：播放器＋傳輸列＋來源時間軸＋專案軌＋側欄。
 * 模式膠囊／脈絡橫幅、狀態列（引擎異常、代理檔建議）、事件篩選 chip 帶計數。
 * 專案軌（Track 13）：片段卡、拖曳重排、把手微調、軌頭操作與新專案對話框。
 */
export function StudioScreen({ videoPath, onBack, onOpenVideo, playbackRequest, onPlaybackRequestConsumed, preloadedDoc }: StudioScreenProps): JSX.Element {
  const {
    project,
    apply,
    undo,
    redo,
    canUndo,
    canRedo,
    newProject,
    saveState,
    missingItemIds
  } = useProject()
  const toast = useToast()
  const overlay = useOverlay()

  /* ---------------- 匯出抽屜（Task 15）：控制器在工作室層，抽屜縮小為徽章時匯出照常進行 ---------------- */
  const exportCtl = useMemo(() => createExportController(windowExportApi, 'highlight'), [])
  const exportState = useSyncExternalStore(exportCtl.subscribe, exportCtl.getState, exportCtl.getState)
  const exporting = exportState.phase === 'running'
  useEditorLock(exporting)
  const [exportOpen, setExportOpen] = useState(false)
  const exportOpenRef = useRef(false)
  exportOpenRef.current = exportOpen
  const [exportBase, setExportBase] = useState<ExportPlanBase | null>(null)
  useEffect(() => () => exportCtl.dispose({ cancelIfRunning: true }), [exportCtl])

  const videoRef = useRef<HTMLVideoElement>(null)
  const tlRef = useRef<TimelineHandle>(null)
  const [state, dispatch] = useReducer(viewerReducer, { videoPath, doc: preloadedDoc }, initViewerState)
  const [mode, dispatchMode] = useReducer(reduceMode, videoPath, createMode)

  /** 來源播放頭（專案預覽時同步片段在來源中的時間） */
  const [currentTime, setCurrentTime] = useState(0)
  /** 專案預覽中的影片時間（只驅動專案軌進度／分割／續播） */
  const [previewTime, setPreviewTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(playbackRequest?.speed ?? 1.0)
  const [asideOpen, setAsideOpen] = useState(true)
  const [addEventAt, setAddEventAt] = useState<number | null>(null)
  const [autoClipOpen, setAutoClipOpen] = useState(false)
  const [bladeMode, setBladeMode] = useState(false)
  const [sourceTrim, setSourceTrim] = useState<{ id: string; edge: 'start' | 'end'; t: number } | null>(null)
  const hoverPreviewRef = useRef<{ time: number; playing: boolean } | null>(null)
  const scrubSessionRef = useRef<{ item: ProjectItem | null; time: number; playing: boolean } | null>(null)
  const previewRestoreRef = useRef<{ id: string; time: number; playing: boolean } | null>(null)
  const [activeClipId, setActiveClipId] = useState<string | null>(null)
  /** 專案軌選取片段（Alt+←/→、Ctrl+D、Delete、Enter 作用對象） */
  const [selProjId, setSelProjId] = useState<string | null>(null)
  /** 新專案對話框開啟中（暫停全域 keymap） */
  const [projDlgOpen, setProjDlgOpen] = useState(false)
  /** 設定快照（自動放置建議、浮層預設參數、專案軌收合、事件前秒數、代理檔建議）；尚未讀到時以 DEFAULT_SETTINGS 為準 */
  const [settings, setSettings] = useState<StudioSettings | null>(null)
  /** 尚未讀到設定時以預設值運作（自動放置建議仍等 settings 讀到才執行） */
  const cfg = settings ?? STUDIO_SETTINGS_DEFAULTS

  const [reloadKey, setReloadKey] = useState(0)
  const [blocked, setBlocked] = useState(false)
  /** 分析結果已載入（載入前不顯示假的預設文件） */
  const [loaded, setLoaded] = useState(Boolean(preloadedDoc))
  /** 載入失敗：code 與 message 分開（code 進狀態列文案，message 供複製） */
  const [loadError, setLoadError] = useState<{ code?: string | number; message: string } | null>(null)
  const [proxyPct, setProxyPct] = useState<number | null>(null)
  const [playability, setPlayability] = useState<PlayabilityResult>(DEFAULT_PLAYABILITY)
  const [proxyPath, setProxyPath] = useState<string | null>(null)
  const [proxyState, setProxyState] = useState<'none' | 'available' | 'generating'>('none')
  const [proxyDismissed, setProxyDismissed] = useState(false)
  const [live, setLive] = useState('')

  const duration = state.doc.video?.duration || 100
  const displayedProject = useMemo(() => sourceTrim
    ? trimItem(project, sourceTrim.id, sourceTrim.edge, sourceTrim.t, duration) : project, [project, sourceTrim, duration])
  const previewItem = currentItem(mode, project)
  const sourceProjectItem = previewItem ?? displayedProject.items.find((item) => item.id === selProjId)
  const sourceRange = sourceProjectItem && normPath(sourceProjectItem.source) === normPath(videoPath)
    ? displayedProject.items.find((item) => item.id === sourceProjectItem.id) ?? null : null
  const allowUnanalyzed = useRef(Boolean(playbackRequest)).current
  const switchingSourceRef = useRef(false)
  const importingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const stateRef = useRef(state)
  stateRef.current = state

  // 專案軌收合：'auto' 依視窗高度（≤800px 收合）；使用者切換後記進 settings
  const autoCollapse = useMediaQuery('(max-height: 800px)')
  const collapsePref = cfg.projectTrackCollapsed
  const projCollapsed = collapsePref === 'auto' ? autoCollapse : collapsePref

  // 供 timeupdate 讀取（避免每幀重建 callback）
  const previewRef = useRef<{ item: ProjectItem | null }>({ item: null })
  previewRef.current = { item: previewItem }

  // 專案狀態的最新快照（Toast〔復原〕在觸發後才執行，不能閉包舊值）
  const projectRef = useRef(project)
  projectRef.current = project

  // 片段的最新快照（建議合併在 await 之後才執行，不能閉包舊值）
  const clipsRef = useRef(state.clips)
  clipsRef.current = state.clips

  // 分析結果世代（每次載入／重新分析完成 +1）：每個世代只規劃一次建議
  const [analysisGen, setAnalysisGen] = useState(preloadedDoc ? 1 : 0)
  const handledGen = useRef(0)
  /** 建議請求序號：使用者套用浮層或有更新的請求時，較舊的回應一律丟棄 */
  const suggestSeq = useRef(0)

  /* ---------------- 載入（先查條目狀態 → cache:load → 必要時 analyze；見 studioLoader） ---------------- */

  useEffect(() => {
    if (preloadedDoc) return
    let cancelled = false
    setBlocked(false)
    setLoadError(null)
    const load = async (): Promise<void> => {
      if (longFixtureRequested()) {
        const { buildLongDoc } = await import('../dev/longFixture')
        if (!cancelled) {
          dispatch({ type: 'analysisResult', doc: buildLongDoc(videoPath) })
          setAnalysisGen((g) => g + 1)
          setLoaded(true)
        }
        return
      }
      const api = window.api
      const outcome = await loadStudioDoc(videoPath, {
        getStatus: async (p) => {
          const entries: { path: string; status: string }[] | undefined = await api?.library?.getEntries?.()
          return entries?.find((e) => normPath(e.path) === normPath(p))?.status ?? null
        },
        cacheLoad: async (p) => ((await api?.cache?.loadByVideo?.(p)) as CacheDoc | null) ?? null,
        analyze: async (args) => ((await api?.engine?.analyze?.(args)) as CacheDoc | null) ?? null,
        probe: async (p) => (await api?.engine?.probe?.(p)) ?? null
      }, allowUnanalyzed)
      if (cancelled) return
      if (outcome.kind === 'blocked') {
        setBlocked(true)
        return
      }
      if (outcome.kind === 'error') {
        console.error('Failed to load studio doc:', outcome.message)
        setLoadError({ code: outcome.code, message: outcome.message })
        return
      }
      dispatch({ type: 'analysisResult', doc: outcome.doc })
      setAnalysisGen((g) => g + 1)
      setLoaded(true)
      void checkSmooth(outcome.doc.video).then((pl) => {
        if (!cancelled) setPlayability(pl)
      })
      if (api?.proxy?.get) {
        try {
          const pp: string | null = await api.proxy.get(videoPath)
          if (!cancelled && pp) {
            setProxyPath(pp)
            setProxyState('available')
          }
        } catch (err) {
          console.error('Failed to get proxy:', err)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPath, reloadKey])

  // dirty：1 秒去抖後寫回快取。離開工作室（卸載）、關閉視窗（beforeunload）與 main 的 flushRequest
  // 都會同步寫入尚未落盤的編輯（I4），不會丟掉最後 1 秒。
  const cacheSaver = useRef<AutosaveController<CacheDoc> | null>(null)
  if (!cacheSaver.current) {
    cacheSaver.current = new AutosaveController<CacheDoc>({
      delayMs: 1000,
      save: (doc) => void window.api?.cache?.save?.(doc),
      saveSync: (doc) => void window.api?.cache?.saveSync?.(doc)
    })
  }
  useEffect(() => {
    const saver = cacheSaver.current!
    const flush = (): void => saver.flushSync()
    window.addEventListener('beforeunload', flush)
    const offRequest = window.api?.projects?.onFlushRequest?.(flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      offRequest?.()
      saver.flushSync()
      saver.dispose()
    }
  }, [])
  useEffect(() => {
    if (!state.dirty) return
    cacheSaver.current!.update(state.doc)
  }, [state.dirty, state.doc])

  // 未分析的來源先開放剪輯；佇列完成後只更新文件，保留播放與尚未落盤的編輯。
  useEffect(() => {
    if (!loaded || state.doc.analysis.status === 'done') return
    let cancelled = false
    let refreshing = false
    const refresh = async (): Promise<void> => {
      if (refreshing) return
      refreshing = true
      try {
        const entries = await window.api.library.getEntries()
        if (cancelled || !entries.some((e: { path: string; status: string }) => normPath(e.path) === normPath(videoPath) && e.status === 'done')) return
        const doc: CacheDoc | null = await window.api.cache.loadByVideo(videoPath)
        if (cancelled || doc?.analysis.status !== 'done') return
        const previous = stateRef.current
        const merged = viewerReducer(previous, { type: 'analysisResult', doc })
        cacheSaver.current!.cancelPending()
        if (previous.dirty || previous.clips.length || previous.doc.events.some((e) => e.source === 'manual')) {
          cacheSaver.current!.update(merged.doc)
        }
        dispatch({ type: 'analysisResult', doc })
        setAnalysisGen((g) => g + 1)
      } catch {
        if (!cancelled) toast({ message: i18n.studio.toast.analysisRefreshFailed })
      } finally {
        refreshing = false
      }
    }
    const off = window.api?.library?.onUpdated?.(() => { void refresh() })
    void refresh()
    return () => { cancelled = true; off?.() }
  }, [loaded, state.doc.analysis.status, videoPath, toast])

  /* ---------------- 設定與自動放置建議 ---------------- */

  // 讀取設定並訂閱 settings:changed（前後秒數、代理檔建議、AI 預設參數、專案軌收合設定變更免重啟）
  useEffect(() => subscribeStudioSettings(window.api, setSettings), [])

  // 分析完成後的建議（spec §3.2.6、§4.2）：引擎文件只含手動片段，所以
  // - 載入且沒有 AI 片段＋設定開啟＝自動放置建議；
  // - 已有 AI 片段的影片重新分析＝一律以預設參數重跑 autoclip，mergeOnReanalyze 合併
  //   （已加入→stale 保留、舊建議／略過丟棄、新建議加入）。
  // 每個分析世代只做一次；引擎不可用時不呼叫。
  useEffect(() => {
    if (!settings || analysisGen === 0 || handledGen.current === analysisGen) return
    handledGen.current = analysisGen
    // 「重新分析」由文件旗標 app.suggestionsPending 決定（main 在重新分析後寫入；工作室全新掛載時
    // 狀態沒有任何片段，無從從狀態得知）
    const plan = planSuggestions({ doc: state.doc, clips: clipsRef.current, settings })
    if (plan.kind === 'none') {
      // 無從建議（例如沒有事件）：仍清除旗標，避免每次開啟都被視為待重算
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
        if (seq !== suggestSeq.current) return // 期間使用者套用了浮層或有更新的請求
        const fresh: Clip[] = Array.isArray(res?.clips) ? res.clips : []
        if (plan.kind === 'place' && fresh.length === 0) return
        // 套用後清除旗標並存檔：同一次重新分析只合併一次，之後使用者的略過不會被覆蓋
        // （autoclip 失敗時不清除，下次開啟再試）
        dispatch({ type: 'applySuggestions', clips: mergeSuggestions(plan.kind, clipsRef.current, fresh) })
      } catch (err) {
        console.error('Failed to place AI suggestions:', err)
      }
    })()
  }, [settings, state.doc, analysisGen, duration])

  // 精華分頁開啟時確保有作用中卡片（roving tabindex 的第一站）
  useEffect(() => {
    setActiveClipId((prev) =>
      prev && state.clips.some((c) => c.id === prev) ? prev : nextSuggestion(state.clips, null, 1)
    )
  }, [state.clips])

  /* ---------------- 播放控制 ---------------- */

  // 供事件處理器讀取的最新值（避免閉包舊值與每幀重建 callback）
  const modeRef = useRef(mode)
  modeRef.current = mode
  const speedRef = useRef(speed)
  speedRef.current = speed

  /** 專案模式守衛：來源文件編輯類動作（含 Toast〔復原〕／〔建立合輯〕）在專案模式一律忽略並提示。 */
  const guarded = useCallback(
    <A extends unknown[]>(cmd: Command | SourceEditCommand, fn: (...a: A) => void) =>
      (...a: A): void => {
        if (guardCommand(modeRef.current.mode, cmd) === 'blocked') {
          toast({ message: i18n.studio.toast.sourceOnlyEdit })
          return
        }
        fn(...a)
      },
    [toast]
  )
  /** 來源播放頭的即時值 */
  const currentTimeRef = useRef(0)
  /** 目前 <video> 已載入完成的 src（loadedmetadata 後才有值；換檔時清空） */
  const loadedSrcRef = useRef<string | null>(null)
  /** 等新 src 載入後才套用的 seek（絕不對即將被替換的 <video> 設 currentTime） */
  const pendingSeekRef = useRef<{ t: number; play: boolean } | null>(null)

  const sourceSrc = useMemo(() => fileUrl(proxyPath ?? videoPath), [proxyPath, videoPath])
  const videoSrc = sourceSrc
  const sourceSrcRef = useRef(sourceSrc)
  sourceSrcRef.current = sourceSrc
  const videoSrcRef = useRef(videoSrc)
  videoSrcRef.current = videoSrc

  /** 要求把 <video> 移到 t：目標檔已載入則立即套用，否則記下等 loadedmetadata。 */
  const requestSeek = useCallback((t: number, wantedSrc: string, play: boolean): void => {
    const el = videoRef.current
    if (el && planSeek({ loadedSrc: loadedSrcRef.current, wantedSrc }) === 'now') {
      pendingSeekRef.current = null
      el.currentTime = toCurrentTime(t, 0)
      if (play) void el.play().catch(() => {})
      return
    }
    pendingSeekRef.current = { t, play }
  }, [])

  const handleLoadedMetadata = useCallback((): void => {
    const el = videoRef.current
    if (!el) return
    loadedSrcRef.current = videoSrcRef.current
    el.playbackRate = speedRef.current // 每次換檔後重新套用播放速度
    const p = pendingSeekRef.current
    if (p) {
      pendingSeekRef.current = null
      el.currentTime = toCurrentTime(p.t, 0)
      if (p.play) void el.play().catch(() => {})
    }
  }, [])

  // 換檔：舊的「已載入」標記失效；代理檔就緒時保住來源／專案預覽的位置與播放狀態
  const prevSrcRef = useRef(videoSrc)
  useEffect(() => {
    if (prevSrcRef.current === videoSrc) return
    prevSrcRef.current = videoSrc
    loadedSrcRef.current = null
    if (!pendingSeekRef.current) {
      pendingSeekRef.current = { t: currentTimeRef.current, play: isPlaying }
    }
  }, [videoSrc])

  /** 來源播放頭目前的時間（換檔中以保存的時間為準）。 */
  const sourcePlayTime = useCallback((): number => {
    const el = videoRef.current
    if (hoverPreviewRef.current) return hoverPreviewRef.current.time
    if (
      !el ||
      pendingSeekRef.current ||
      loadedSrcRef.current !== sourceSrcRef.current
    ) {
      return currentTimeRef.current
    }
    return el.currentTime
  }, [])

  // 鍵盤驅動的播放頭／縮放變更：限速、polite 的 aria-live 播報
  const announcerRef = useRef<ReturnType<typeof createAnnouncer> | null>(null)
  useEffect(() => {
    const a = createAnnouncer(setLive)
    announcerRef.current = a
    return () => a.dispose()
  }, [])
  const announce = useCallback((msg: string): void => announcerRef.current?.announce(msg), [])

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }, [])

  const cycleSpeed = useCallback(() => {
    const speeds = [1.0, 0.5, 0.25, 2.0]
    setSpeed((prev) => {
      const next = speeds[(speeds.indexOf(prev) + 1) % speeds.length]
      if (videoRef.current) videoRef.current.playbackRate = next
      return next
    })
  }, [])

  /** 任何針對「來源」的 seek（時間軸、事件、精華預覽、方向鍵）：專案模式先回到來源，換檔後才套用時間。 */
  const seekTo = useCallback(
    (t: number) => {
      const clamped = Math.max(0, t)
      if (modeRef.current.mode === 'project') dispatchMode({ type: 'seekSource' })
      requestSeek(clamped, sourceSrcRef.current, false)
      currentTimeRef.current = clamped
      setCurrentTime(clamped)
    },
    [requestSeek]
  )

  /** 拖曳先暫停；放開後依原播放狀態恢復，取消則還原原本的專案預覽。 */
  const startScrub = useCallback((): void => {
    const el = videoRef.current
    scrubSessionRef.current = { item: previewRef.current.item, time: el?.currentTime ?? 0, playing: !!el && !el.paused }
    el?.pause()
  }, [])
  const endScrub = useCallback((cancelled: boolean): void => {
    const session = scrubSessionRef.current
    scrubSessionRef.current = null
    if (!session) return
    if (cancelled && session.item && projectRef.current.items.some((item) => item.id === session.item!.id)) {
      if (modeRef.current.mode === 'project') {
        dispatchMode({ type: 'playItem', item: session.item })
        requestSeek(session.time, videoSrcRef.current, session.playing)
        return
      }
      previewRestoreRef.current = { id: session.item.id, time: session.time, playing: session.playing }
      dispatchMode({ type: 'playItem', item: session.item })
    } else requestSeek(currentTimeRef.current, sourceSrcRef.current, session.playing)
  }, [requestSeek])

  /** 刀片懸停只換預覽影格，來源播放頭與儲存時間保持原位。 */
  const hoverSeek = useCallback((t: number | null): void => {
    const el = videoRef.current
    if (t === null) {
      const session = hoverPreviewRef.current
      hoverPreviewRef.current = null
      if (session) requestSeek(session.time, sourceSrcRef.current, session.playing)
      return
    }
    if (modeRef.current.mode !== 'source') return
    if (!hoverPreviewRef.current) {
      const time = sourcePlayTime()
      hoverPreviewRef.current = { time, playing: !!el && !el.paused }
      currentTimeRef.current = time
      setCurrentTime(time)
      el?.pause()
    }
    requestSeek(t, sourceSrcRef.current, false)
  }, [requestSeek, sourcePlayTime])

  /** 返回來源（Esc／橫幅按鈕）：停在目前片段的來源時間，方便接續剪輯。 */
  const backToSource = useCallback(() => {
    if (modeRef.current.mode !== 'project') return
    dispatchMode({ type: 'backToSource' })
    videoRef.current?.pause()
    requestSeek(currentTimeRef.current, sourceSrcRef.current, false)
  }, [requestSeek])

  // 預覽中的片段不存在（例如被復原移除）→ 退回來源
  useEffect(() => {
    if (reconcileMode(mode, project) !== mode) backToSource()
  }, [mode, project, backToSource])

  const seekBy = useCallback(
    (delta: number) => {
      const target = Math.max(0, Math.min(duration, sourcePlayTime() + delta))
      seekTo(target)
      announce(i18n.studio.live.playhead.replace('{time}', formatTime(target)))
    },
    [duration, sourcePlayTime, seekTo, announce]
  )

  /** 剛由 Ctrl+←/→ 跳到的事件（播放頭停在其 lead-in 時，以事件時間為下一次導覽的基準；見 eventNav） */
  const navAnchorRef = useRef<NavAnchor | null>(null)
  const seekEvent = useCallback(
    (dir: 1 | -1) => {
      const ev = nextEvent(state.doc.events, navReference(currentTimeRef.current, navAnchorRef.current), dir, state.filter)
      if (!ev) return
      const target = leadInSeek(ev.t, cfg.before)
      seekTo(target)
      navAnchorRef.current = { eventT: ev.t, seekT: target }
      // 播報事件本身：類型、時間、計入與否（不計入含原因），而不只是播放頭時間
      announce(eventAriaLabel(ev))
    },
    [state.doc.events, state.filter, seekTo, announce, cfg.before]
  )

  const handleSelectEvent = useCallback(
    (ev: { t: number }) => {
      seekTo(leadInSeek(ev.t, cfg.before))
    },
    [seekTo, cfg.before]
  )

  const missingRef = useRef(missingItemIds)
  missingRef.current = missingItemIds
  /** 已為某片段觸發過換段（避免 timeupdate／影格回呼／ended 對同一段重複換） */
  const advancedForRef = useRef<string | null>(null)

  /** 同來源直接播放；跨來源先同步存檔，再交由 App 重新掛載並接續指定片段。 */
  const playProjectItem = useCallback((item: ProjectItem): void => {
    if (switchingSourceRef.current) return
    if (missingRef.current.has(item.id)) {
      toast({ message: i18n.studio.track.missingToast })
      return
    }
    if (normPath(item.source) !== normPath(videoPath)) {
      if (exportCtl.getState().phase === 'running') {
        videoRef.current?.pause()
        toast({ message: i18n.export.backBlocked })
        return
      }
      if (stateRef.current.dirty) {
        try {
          if (window.api.cache.saveSync(stateRef.current.doc) === false) throw new Error('cache save')
          cacheSaver.current!.cancelPending()
        } catch {
          videoRef.current?.pause()
          toast({ message: i18n.studio.toast.sourceSaveFailed })
          return
        }
      } else cacheSaver.current!.flushSync()
      switchingSourceRef.current = true
      videoRef.current?.pause()
      loadedSrcRef.current = null
      onOpenVideo(item.source, { playItemId: item.id, speed: speedRef.current })
      return
    }
    setSelProjId(item.id)
    if (previewRef.current.item?.id === item.id) {
      advancedForRef.current = null
      currentTimeRef.current = item.start
      setCurrentTime(item.start)
      setPreviewTime(item.start)
      requestSeek(item.start, sourceSrcRef.current, true)
    } else dispatchMode({ type: 'playItem', item })
  }, [videoPath, exportCtl, toast, onOpenVideo, requestSeek])

  const consumedRequest = useRef(false)
  useEffect(() => {
    if (!loaded || !playbackRequest || consumedRequest.current) return
    const item = project.items.find((i) => i.id === playbackRequest.playItemId)
    if (!item) return
    consumedRequest.current = true
    playProjectItem(item)
    onPlaybackRequestConsumed?.()
  }, [loaded, playbackRequest, project.items, playProjectItem, onPlaybackRequestConsumed])

  /** 離開 item 往下一段：跳過來源缺失的片段；全缺失或沒有下一段就暫停（缺失時 Toast）。 */
  const advanceFrom = useCallback(
    (item: ProjectItem): void => {
      if (advancedForRef.current === item.id) return
      advancedForRef.current = item.id
      const r = nextPlayableItem(projectRef.current, item.id, missingRef.current)
      if (r.kind === 'item') {
        playProjectItem(r.item)
        return
      }
      videoRef.current?.pause()
      if (r.kind === 'allMissing') toast({ message: i18n.studio.track.restMissingToast })
    },
    [toast, playProjectItem]
  )

  /** 播放時間 t 已到片段尾端 → 換段（可跨影片）。 */
  const advanceIfEnded = useCallback(
    (item: ProjectItem, t: number): void => {
      const step = nextAfter(projectRef.current, item.id, t, missingRef.current)
      if (step.kind === 'continue') return
      advanceFrom(item)
    },
    [advanceFrom]
  )

  const handlePlayingChange = useCallback((playing: boolean): void => {
    if (playing && !switchingSourceRef.current) advancedForRef.current = null // 使用者重新播放：允許再次在片段尾端暫停／換段
    setIsPlaying(playing)
  }, [])

  /** <video> 播到實際檔尾：片段尾端超出影片長度時也要能接續，不可卡住。 */
  const handleVideoEnded = useCallback((): void => {
    if (hoverPreviewRef.current) return
    const item = previewRef.current.item
    if (item && loadedSrcRef.current === videoSrcRef.current) advanceFrom(item)
  }, [advanceFrom])

  /** 載入失敗：作廢待套用 seek 與已載入標記，播放旗標歸 false。 */
  const handleVideoError = useCallback((): void => {
    const r = onVideoError({ loadedSrc: loadedSrcRef.current, pending: pendingSeekRef.current })
    loadedSrcRef.current = r.loadedSrc
    pendingSeekRef.current = r.pending
    setIsPlaying(r.playing)
    if (previewRef.current.item) toast({ message: i18n.studio.track.missingToast })
    // 來源模式的影片載入失敗＝影片缺失或無法播放：顯示 notice（重新連結／返回影片庫）
    else setVideoMissing(true)
  }, [toast])

  // 專案預覽同步來源播放頭，並依序接續片段；換檔期間忽略舊影片殘留事件。
  const handleTimeUpdate = useCallback((t: number) => {
    if (hoverPreviewRef.current || switchingSourceRef.current) return
    const item = previewRef.current.item
    const route = routeTimeUpdate({
      previewSrc: item ? videoSrcRef.current : null,
      sourceSrc: sourceSrcRef.current,
      loadedSrc: loadedSrcRef.current,
      pending: pendingSeekRef.current !== null
    })
    if (route === 'ignore') return
    currentTimeRef.current = t
    setCurrentTime(t)
    if (route === 'source') return
    setPreviewTime(t)
    if (!item) return
    advanceIfEnded(item, t)
  }, [advanceIfEnded])

  // 進入／切換預覽片段：載入後 seek 到片段起點並播放（spec §3.5）
  useEffect(() => {
    if (!previewItem) return
    advancedForRef.current = null
    const restore = previewRestoreRef.current
    previewRestoreRef.current = null
    const start = restore?.id === previewItem.id ? restore.time : Math.max(0, previewItem.start)
    currentTimeRef.current = start
    setCurrentTime(start)
    setPreviewTime(start)
    requestSeek(start, videoSrc, restore?.id === previewItem.id ? restore.playing : true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewItem?.id, previewItem?.start])

  // 片段尾端檢查：timeupdate 約每 250 ms 才觸發一次，另以影格回呼（無則 100 ms 計時器）補強，
  // 播放中才排程、每次只比較一個數字，CPU 成本可忽略。
  useEffect(() => {
    const el = videoRef.current
    const item = previewItem
    if (!el || !item || !isPlaying) return
    const check = (): void => {
      if (loadedSrcRef.current !== videoSrcRef.current || pendingSeekRef.current) return
      if (el.currentTime >= item.end) advanceFrom(item)
    }
    type Rvfc = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
      cancelVideoFrameCallback?: (id: number) => void
    }
    const v = el as Rvfc
    if (typeof v.requestVideoFrameCallback === 'function') {
      let id = 0
      let stopped = false
      const loop = (): void => {
        if (stopped) return
        check()
        id = v.requestVideoFrameCallback!(loop)
      }
      id = v.requestVideoFrameCallback(loop)
      return () => {
        stopped = true
        v.cancelVideoFrameCallback?.(id)
      }
    }
    const timer = window.setInterval(check, 100)
    return () => window.clearInterval(timer)
  }, [previewItem, advanceFrom, isPlaying])

  /* ---------------- 模式膠囊／脈絡 ---------------- */

  const previewIndex = previewItem ? project.items.findIndex((i) => i.id === previewItem.id) + 1 : 0
  const modeLabel = useMemo(() => {
    const m = i18n.studio.mode
    if (mode.mode === 'source' || !previewItem) return `${m.source} · ${baseName(videoPath)}`
    const item = m.item.replace('{i}', String(previewIndex)).replace('{n}', String(project.items.length))
    return `${m.project} · ${item} · ${formatTime(previewItem.start)}–${formatTime(previewItem.end)}`
  }, [mode.mode, previewItem, previewIndex, project.items.length, videoPath])

  /** 目前片段內的播放進度（專案模式卡片進度條）。 */
  const previewProgress = useMemo(() => {
    if (!previewItem) return 0
    const len = Math.max(1e-6, previewItem.end - previewItem.start)
    return Math.max(0, Math.min(1, (previewTime - previewItem.start) / len))
  }, [previewItem, previewTime])

  /** 片段標籤：目前影片內有對應片段時用「N 殺精華」等，否則通用標題。 */
  const labelOf = useCallback(
    (item: ProjectItem): string => {
      if (normPath(item.source) === normPath(videoPath)) {
        const clip = state.clips.find(
          (c) => Math.abs(c.start - item.start) < 1e-3 && Math.abs(c.end - item.end) < 1e-3
        )
        if (clip) return clipTitle(clip, state.doc.events)
      }
      return i18n.studio.hl.genericTitle
    },
    [state.clips, state.doc.events, videoPath]
  )

  const spectatingNow = useMemo(
    () => state.doc.spectating.some((s) => currentTime >= s.start && currentTime <= s.end),
    [state.doc.spectating, currentTime]
  )
  const recentCounted = useMemo(() => nearCount(state.doc.events, currentTime), [state.doc.events, currentTime])

  /* ---------------- 狀態列（引擎異常／代理檔） ---------------- */

  const [videoMissing, setVideoMissing] = useState(false)
  useEffect(() => setVideoMissing(false), [videoPath, reloadKey])
  const docAnalysis = state.doc.analysis
  const notice: StudioNotice | null = useMemo(() => {
    const base = studioNotice({
      analysis: 'done',
      videoMissing,
      playability,
      proxyState,
      proxySuggest: cfg.proxySuggest
    })
    if (proxyDismissed && base?.id === 'proxy-suggest') return null
    return base
  }, [playability, proxyState, proxyDismissed, cfg.proxySuggest, docAnalysis, videoMissing])

  const busyNotice: StudioNotice | null = useMemo(
    () => (proxyState === 'generating' ? proxyBusyNotice(proxyPct) : null),
    [proxyState, proxyPct]
  )
  const shownNotice = notice ?? busyNotice

  // 代理檔產生進度（主程序解析 ffmpeg 輸出後推送）
  useEffect(() => {
    const off = window.api?.proxy?.onProgress?.((d: { videoPath: string; ratio: number }) => {
      if (normPath(d.videoPath) === normPath(videoPath)) setProxyPct(d.ratio)
    })
    return () => off?.()
  }, [videoPath])

  const handleGenerateProxy = useCallback(async (): Promise<void> => {
    setProxyState('generating')
    setProxyPct(null)
    try {
      const p: string | null = await window.api?.proxy?.generate?.(videoPath, duration)
      if (p) {
        setProxyPath(p)
        setProxyState('available')
      } else {
        setProxyState('none')
      }
    } catch (err) {
      console.error('Failed to generate proxy:', err)
      setProxyState('none')
    }
  }, [videoPath, duration])

  /** 返回影片庫；匯出進行中不離開（改用 Toast 提示） */
  const requestBack = useCallback((): void => {
    if (exportCtl.getState().phase === 'running') {
      toast({ message: i18n.export.backBlocked })
      return
    }
    onBack()
  }, [exportCtl, toast, onBack])

  const handleNoticeAction = useCallback(
    (a: NoticeAction): void => {
      if (a === 'resume') {
        setLoadError(null)
        setReloadKey((k) => k + 1)
      } else if (a === 'copyError') {
        void navigator.clipboard?.writeText(loadError?.message ?? '').catch(() => {})
        toast({ message: i18n.studio.toast.copied })
      } else if (a === 'generateProxy') {
        void handleGenerateProxy()
      } else if (a === 'later') {
        setProxyDismissed(true)
      } else if (a === 'back') {
        requestBack()
      } else if (a === 'relink') {
        // 重新連結：回到影片庫，由使用者移除失效項目後重新匯入檔案
        toast({ message: i18n.studio.toast.relinkHint })
        requestBack()
      }
    },
    [loadError, handleGenerateProxy, toast, requestBack]
  )

  /* ---------------- 編輯操作 ---------------- */

  /** 分割（Ctrl+Q／軌頭剪刀，專案模式）：播放頭需在目前播放片段內（±0.5 秒邊界）。 */
  const splitProjectAtPlayhead = useCallback(() => {
    const item = previewRef.current.item
    const t = videoRef.current?.currentTime ?? currentTime
    if (mode.mode !== 'project' || !item || t <= item.start + 0.5 || t >= item.end - 0.5) {
      toast({ message: i18n.studio.toast.splitHint })
      return
    }
    const next = splitItem(projectRef.current, item.id, t)
    if (next === projectRef.current) {
      toast({ message: i18n.studio.toast.splitHint })
      return
    }
    apply(next)
    const at = next.items.findIndex((i) => i.id === item.id)
    const second = at >= 0 ? next.items[at + 1] : undefined
    if (second) {
      setSelProjId(second.id)
      dispatchMode({ type: 'playItem', item: second })
    }
  }, [mode.mode, currentTime, apply, toast])

  /** 來源模式切換刀片；專案模式仍在播放頭分割。 */
  const handleQuickOrSplit = useCallback(() => {
    if (mode.mode === 'project') splitProjectAtPlayhead()
    else setBladeMode((enabled) => !enabled)
  }, [mode.mode, splitProjectAtPlayhead])

  const createBladeClip = useCallback((start: number, end: number): void => {
    const clip: Clip = { id: `c_${crypto.randomUUID()}`, start, end, origin: 'manual', event_ids: [], status: 'accepted' }
    const res = acceptToProject(clip, videoPath, projectRef.current)
    if (res.added.length === 0) return
    dispatch({ type: 'addClip', clip })
    apply(addItems(projectRef.current, res.added))
    toast({
      message: i18n.studio.toast.addedProject.replace('{sec}', String(Math.round(end - start))),
      action: {
        label: i18n.studio.toast.undo,
        run: guarded('editClips', () => {
          apply(res.undo(projectRef.current))
          dispatch({ type: 'removeClip', id: clip.id })
        })
      }
    })
  }, [videoPath, apply, toast, guarded])

  useEffect(() => {
    if (mode.mode !== 'source') setBladeMode(false)
  }, [mode.mode])

  /** 處理完目前建議後，把作用中卡片移到下一個建議（以處理前的清單計算）。 */
  const advanceActive = useCallback(
    (fromId: string) => {
      setActiveClipId(nextSuggestion(state.clips, fromId, 1))
    },
    [state.clips]
  )

  /** 預覽片段：退出專案模式並跳到片段起點（seekTo 負責回到來源與換檔後套用時間）。 */
  const previewClip = useCallback(
    (clip: Clip) => {
      seekTo(Math.max(0, clip.start))
    },
    [seekTo]
  )

  /** 加入建議（卡片／Enter）：加入專案、標記已加入；Toast〔復原〕同時移除專案片段並讓卡片回到建議。 */
  const acceptClip = useCallback(
    (clip: Clip) => {
      const plan = planAccept(clip, videoPath, projectRef.current)
      if (plan.notice === 'added') apply(plan.project)
      dispatch({ type: 'acceptClip', id: clip.id })
      if (plan.undo) {
        const undo = plan.undo
        toast({
          message: i18n.studio.toast.addedProject.replace(
            '{sec}',
            String(Math.round(Math.max(0, clip.end - clip.start)))
          ),
          action: {
            label: i18n.studio.toast.undo,
            run: guarded('editClips', () => {
              apply(undo.project(projectRef.current))
              dispatch({ type: undo.clipStatus === 'suggested' ? 'restoreClip' : 'acceptClip', id: clip.id })
            })
          }
        })
      } else {
        toast({ message: i18n.studio.toast.alreadyInProject })
      }
      advanceActive(clip.id)
    },
    [videoPath, apply, toast, advanceActive, guarded]
  )

  /** 略過建議（卡片／Delete）：標記已略過，Toast〔復原〕回到建議。 */
  const skipClip = useCallback(
    (clip: Clip) => {
      dispatch({ type: 'skipClip', id: clip.id })
      toast({
        message: i18n.studio.toast.skipped,
        action: { label: i18n.studio.toast.undo, run: guarded('editClips', () => dispatch({ type: 'restoreClip', id: clip.id })) }
      })
      advanceActive(clip.id)
    },
    [toast, advanceActive, guarded]
  )

  /** 取消略過，回到建議狀態（不顯示 Toast）。 */
  const restoreClip = useCallback((clip: Clip) => {
    dispatch({ type: 'restoreClip', id: clip.id })
  }, [])

  /** 移出專案：AI 片段回到建議、手動片段從清單移除；Toast〔復原〕還原兩者。 */
  const removeFromProject = useCallback(
    (clip: Clip) => {
      const ids = findItemsForClip(clip, videoPath, projectRef.current)
      const items = projectRef.current.items.filter((i) => ids.includes(i.id))
      if (items.length > 0) apply(removeProjectItems(projectRef.current, ids))
      const manual = clip.origin === 'manual'
      dispatch(manual ? { type: 'removeClip', id: clip.id } : { type: 'restoreClip', id: clip.id })
      toast({
        message: i18n.studio.toast.removedFromProject,
        action: {
          label: i18n.studio.toast.undo,
          run: guarded('editClips', () => {
            if (items.length > 0) apply(addItems(projectRef.current, items))
            dispatch(manual ? { type: 'addClip', clip } : { type: 'acceptClip', id: clip.id })
          })
        }
      })
    },
    [videoPath, apply, toast, guarded]
  )

  /** 全部加入（Ctrl+E／底欄）：以幂等的 planAddAll 加入，重複觸發不會產生重複片段；單一 Toast〔復原〕。 */
  const addAllSuggestions = useCallback(() => {
    const suggested = state.clips.filter(isSuggested)
    if (suggested.length === 0) return
    const plan = planAddAll(suggested, videoPath, projectRef.current)
    for (const c of suggested) dispatch({ type: 'acceptClip', id: c.id })
    if (plan.addedIds.length === 0) return
    apply(plan.project)
    const secs = Math.round(suggested.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0))
    toast({
      message: i18n.studio.toast.addedProject.replace('{sec}', String(secs)),
      action: {
        label: i18n.studio.toast.undo,
        run: guarded('editClips', () => {
          apply(removeProjectItems(projectRef.current, plan.addedIds))
          for (const c of suggested) dispatch({ type: 'restoreClip', id: c.id })
        })
      }
    })
  }, [state.clips, videoPath, apply, toast, guarded])

  /** 加入建議（Enter）：只處理目前作用中的建議。 */
  const handleAcceptSuggestion = useCallback(() => {
    const clip = state.clips.find((c) => c.id === activeClipId)
    if (clip && isSuggested(clip)) acceptClip(clip)
  }, [state.clips, activeClipId, acceptClip])

  /** 略過建議（Delete）：只處理目前作用中的建議。 */
  const handleSkipSuggestion = useCallback(() => {
    const clip = state.clips.find((c) => c.id === activeClipId)
    if (clip && isSuggested(clip)) skipClip(clip)
  }, [state.clips, activeClipId, skipClip])

  const projectRefForExport = useRef(project)
  projectRefForExport.current = project
  const missingForExport = useRef(missingItemIds)
  missingForExport.current = missingItemIds
  const docRefForExport = useRef(state.doc)
  docRefForExport.current = state.doc

  /** 開啟抽屜：設定階段重新偵測編碼器／磁碟空間並收集各來源規格；進行中或結果頁直接顯示現況。 */
  const handleOpenExport = useCallback(() => {
    setExportOpen(true)
    if (exportCtl.getState().phase !== 'settings') return
    exportCtl.setBaseName(projectRefForExport.current.name || 'highlight')
    void (async () => {
      let outDir: string | null = null
      try {
        const s = await window.api?.settings?.get?.()
        outDir = typeof s?.defaultOutDir === 'string' ? s.defaultOutDir : null
      } catch {
        outDir = null
      }
      void exportCtl.init(outDir)
    })()
  }, [exportCtl])

  const handleCloseExport = useCallback(() => setExportOpen(false), [])

  // 抽屜設定階段：專案、缺失來源或目前影片資訊變動時重新收集各來源規格（抽屜開著時仍可在專案軌編輯）
  useEffect(() => {
    if (!exportOpen || exportState.phase !== 'settings') return
    let cancelled = false
    const doc = state.doc
    void buildPlanBase(
      project,
      missingItemIds,
      { path: videoPath, info: { codec: doc.video.codec, width: doc.video.width, height: doc.video.height }, keyframes: doc.keyframes ?? [] },
      async (src) => (await window.api?.engine?.probe?.(src)) ?? null
    ).then((b) => {
      if (!cancelled) setExportBase(b)
    })
    return () => {
      cancelled = true
    }
  }, [exportOpen, exportState.phase, project, missingItemIds, state.doc, videoPath])

  // 抽屜縮小時匯出結束：用 Toast 通知並提供〔查看〕
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

  // 僅開發模式：?drawer=… 以假 IPC 直接顯示抽屜狀態（截圖用）；動態載入，正式 bundle 不含
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
        const items = projectRefForExport.current.items.map((i) => ({ id: i.id, source: i.source, start: i.start, end: i.end }))
        void exportCtl.start(items)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  /** 浮層套用：只取代 suggested 的 AI 片段（保留已加入、已略過與手動）並寫回快取。 */
  const handleApplyAutoClip = useCallback(
    (clips: Clip[]) => {
      suggestSeq.current++ // 尚未回來的自動建議不得覆蓋使用者剛套用的結果
      dispatch({ type: 'applyClips', clips: applyAutoClip(clipsRef.current, clips) })
      },
    []
  )

  /* ---------------- 專案軌操作（Task 13） ---------------- */

  // 片段增減時維護選取：專案由空→有自動選第一段；選取片段消失（刪除／換專案）時清除
  const prevItemCount = useRef(0)
  useEffect(() => {
    const n = project.items.length
    if (prevItemCount.current === 0 && n > 0) setSelProjId(project.items[0].id)
    else if (selProjId !== null && !project.items.some((i) => i.id === selProjId)) setSelProjId(null)
    prevItemCount.current = n
  }, [project.items, selProjId])

  /** 把手／步進微調：同影片夾在影片長度內；其他來源無長度資訊不設上界。 */
  const trimProjectItem = useCallback(
    (id: string, edge: 'start' | 'end', t: number) => {
      const item = projectRef.current.items.find((i) => i.id === id)
      const sameVideo = item ? normPath(item.source) === normPath(videoPath) : true
      apply(trimItem(projectRef.current, id, edge, t, sameVideo ? duration : undefined))
    },
    [apply, videoPath, duration]
  )

  /** 拖曳只更新顯示草稿，最後才透過既有 API 建立一筆可復原的編輯。 */
  const trimSourceProjectItem = useCallback((id: string, edge: 'start' | 'end', t: number, phase: 'preview' | 'commit' | 'cancel'): void => {
    if (phase === 'preview') setSourceTrim({ id, edge, t })
    else {
      setSourceTrim(null)
      const item = projectRef.current.items.find((item) => item.id === id)
      if (phase === 'commit' && item) {
        const next = trimItem(projectRef.current, id, edge, t, duration)
        const trimmed = next.items.find((item) => item.id === id)!
        if (trimmed.start !== item.start || trimmed.end !== item.end) trimProjectItem(id, edge, t)
      }
    }
  }, [duration, trimProjectItem])

  const moveProjectItem = useCallback(
    (id: string, toIndex: number) => {
      apply(moveItem(projectRef.current, id, toIndex))
    },
    [apply]
  )

  const renameProject = useCallback(
    (name: string) => {
      apply({ ...projectRef.current, name })
    },
    [apply]
  )

  /** 複製選取片段（Ctrl+D／軌頭）：選取複本（接在本尊之後）。 */
  const duplicateSelectedItem = useCallback(() => {
    const id = selProjId
    if (!id) return
    const before = new Set(projectRef.current.items.map((i) => i.id))
    const next = duplicateItem(projectRef.current, id)
    if (next === projectRef.current) return
    apply(next)
    const clone = next.items.find((i) => !before.has(i.id))
    if (clone) setSelProjId(clone.id)
  }, [selProjId, apply])

  /** 刪除選取片段（Delete／軌頭）：Toast〔復原〕＝undo（移除剛推入的歷史）。 */
  const deleteSelectedItem = useCallback(() => {
    const id = selProjId
    if (!id) return
    // 刪除後選取相鄰片段（後一段優先），鍵盤焦點才不會掉到 body
    const items = projectRef.current.items
    const at = items.findIndex((i) => i.id === id)
    const neighbor = items[at + 1] ?? items[at - 1] ?? null
    apply(removeItem(projectRef.current, id))
    setSelProjId(neighbor ? neighbor.id : null)
    toast({
      message: i18n.studio.toast.deletedItem,
      action: { label: i18n.studio.toast.undo, run: undo }
    })
  }, [selProjId, apply, toast, undo])

  /** ←/→：移動選取片段（無選取時選第一／最後一段）。 */
  const selectProjectItem = useCallback(
    (dir: 1 | -1) => {
      const items = projectRef.current.items
      if (items.length === 0) return
      const at = selProjId ? items.findIndex((i) => i.id === selProjId) : -1
      const next = at < 0 ? (dir === 1 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, at + dir))
      setSelProjId(items[next].id)
    },
    [selProjId]
  )

  /** Alt+←/→：選取片段前移／後移一格。 */
  const shiftSelectedItem = useCallback(
    (dir: 1 | -1) => {
      const id = selProjId
      if (!id) return
      const items = projectRef.current.items
      const at = items.findIndex((i) => i.id === id)
      const to = at + dir
      if (at < 0 || to < 0 || to >= items.length) return
      apply(moveItem(projectRef.current, id, to))
    },
    [selProjId, apply]
  )

  /** Enter：播放選取片段。 */
  const playSelectedItem = useCallback(() => {
    const item = selProjId ? projectRef.current.items.find((i) => i.id === selProjId) : undefined
    if (item) playProjectItem(item)
  }, [selProjId, playProjectItem])

  /** 收合／展開專案軌：記進 settings.projectTrackCollapsed（布林，覆蓋 'auto'）。 */
  const toggleProjCollapsed = useCallback(() => {
    const next = !projCollapsed
    void window.api?.settings?.set?.({ projectTrackCollapsed: next })
    setSettings((prev) => (prev ? { ...prev, projectTrackCollapsed: next } : prev))
  }, [projCollapsed])

  /** 新專案建立前由 session 同步儲存舊專案；失敗時保留目前內容。 */
  const handleNewProjectConfirmed = useCallback(() => {
    if (!newProject()) return
    setSelProjId(null)
    prevItemCount.current = 0
    toast({ message: i18n.studio.toast.newProject })
  }, [newProject, toast])

  /** 外部影片整批加入專案，一次 Undo；先播放第一個成功取得長度的新片段。 */
  const handleAddExternalVideo = useCallback(() => {
    if (importingRef.current || exportCtl.getState().phase === 'running') return
    importingRef.current = true
    void (async () => {
      try {
        const api = window.api
        if (!api) return
        const paths: string[] = await api.library.selectFiles()
        if (paths.length === 0 || !mountedRef.current) return
        const { items, failed } = await importExternalVideos(paths, api)
        if (!mountedRef.current || switchingSourceRef.current) return
        if (failed.length) toast({ message: i18n.studio.toast.externalVideoIncomplete.replace('{names}', failed.map(baseName).join('、')) })
        if (exportCtl.getState().phase === 'running') {
          toast({ message: i18n.export.backBlocked })
          return
        }
        if (!items.length) return
        const firstIndex = projectRef.current.items.length
        const next = addItems(projectRef.current, items)
        apply(next)
        playProjectItem(next.items[firstIndex])
      } catch {
        toast({ message: i18n.studio.toast.addExternalFailed })
      } finally {
        importingRef.current = false
      }
    })()
  }, [toast, exportCtl, apply, playProjectItem])

  /** ＋從來源加入：加入第一段待確認建議（mock 行為）；沒有時 Toast。 */
  const addFirstSuggestion = useCallback(() => {
    const clip = state.clips.find(isSuggested)
    if (clip) acceptClip(clip)
    else toast({ message: i18n.studio.toast.noSuggestions })
  }, [state.clips, acceptClip, toast])

  /* ---------------- 專案模式守衛（來源文件編輯類指令一律忽略＋Toast 提示） ---------------- */

  const openAddEvent = useCallback(() => setAddEventAt(sourcePlayTime()), [sourcePlayTime])
  const gAddEvent = useMemo(() => guarded('addEvent', openAddEvent), [guarded, openAddEvent])
  /* ---------------- 浮層（任一開啟時 keymap 只剩 Esc 關最上層） ---------------- */

  const overlayState: OverlayState = {
    addEvent: addEventAt !== null,
    autoClip: autoClipOpen,
    newProject: projDlgOpen,
    hostDialog: overlay.isOpen && overlay.kind !== 'shortcuts',
    exportDrawer: exportOpen,
    queuePopover: overlay.queueOpen,
    shortcuts: overlay.kind === 'shortcuts'
  }
  const overlayOpen = isAnyOverlayOpen(overlayState)
  const overlayStateRef = useRef(overlayState)
  overlayStateRef.current = overlayState

  /** Esc：關閉最上層浮層。（新專案對話框與佇列浮層自行處理 Esc。） */
  const closeOverlay = useCallback(() => {
    switch (topOverlay(overlayStateRef.current)) {
      case 'addEvent':
        setAddEventAt(null)
        break
      case 'autoClip':
        setAutoClipOpen(false)
        break
      case 'hostDialog':
      case 'shortcuts':
        overlay.close()
        break
      case 'exportDrawer':
        // 進行中＝縮小為徽章（不取消）；其餘狀態回到設定頁並關閉
        if (exportCtl.getState().phase !== 'running') exportCtl.finish()
        setExportOpen(false)
        break
      default:
        break
    }
  }, [overlay, exportCtl])

  /* ---------------- keymap（spec §3.2.7） ---------------- */

  useKeymap(
    {
      play: togglePlay,
      speed: cycleSpeed,
      prevEvent: () => seekEvent(-1),
      nextEvent: () => seekEvent(1),
      seekBack: () => seekBy(-5),
      seekFwd: () => seekBy(5),
      zoomIn: () => {
        tlRef.current?.zoomIn()
        announce(i18n.studio.live.zoomIn)
      },
      zoomOut: () => {
        tlRef.current?.zoomOut()
        announce(i18n.studio.live.zoomOut)
      },
      zoomReset: () => {
        tlRef.current?.zoomReset()
        announce(i18n.studio.live.zoomReset)
      },
      quickOrSplit: handleQuickOrSplit,
      addEvent: gAddEvent,
      addAllToProject: addAllSuggestions,
      acceptSuggestion: handleAcceptSuggestion,
      skipSuggestion: handleSkipSuggestion,
      listPrev: () => setActiveClipId((prev) => nextSuggestion(state.clips, prev, -1)),
      listNext: () => setActiveClipId((prev) => nextSuggestion(state.clips, prev, 1)),
      playItem: playSelectedItem,
      deleteProjectItem: deleteSelectedItem,
      duplicateItem: duplicateSelectedItem,
      moveItemLeft: () => shiftSelectedItem(-1),
      moveItemRight: () => shiftSelectedItem(1),
      selectPrevItem: () => selectProjectItem(-1),
      selectNextItem: () => selectProjectItem(1),
      undo,
      redo,
      openExport: handleOpenExport,
      toggleAside: () => setAsideOpen((v) => !v),
      showShortcuts: overlay.openShortcuts,
      backToSource,
      closeOverlay
    },
    { screen: 'studio', mode: mode.mode, overlayOpen }
  )

  /* ---------------- aria-live（朗讀目前事件） ---------------- */

  const activeEvent = useMemo(() => {
    let best: { id: string; t: number; type: string } | null = null
    for (const e of state.doc.events) {
      if (e.deleted) continue
      const d = Math.abs(e.t - currentTime)
      if (d > 1.2) continue
      if (!best || d < Math.abs(best.t - currentTime)) best = e
    }
    return best
  }, [state.doc.events, currentTime])

  const prevActiveId = useRef<string | null>(null)
  useEffect(() => {
    if (activeEvent?.id === prevActiveId.current) return
    prevActiveId.current = activeEvent?.id ?? null
    if (activeEvent) {
      const type = (i18n.timeline.types as Record<string, string>)[activeEvent.type] ?? activeEvent.type
      setLive(i18n.studio.live.event.replace('{type}', type).replace('{time}', formatTime(activeEvent.t)))
    }
  }, [activeEvent])

  /* ---------------- render ---------------- */

  if (loadError) {
    return (
      <StudioLoadErrorView
        code={loadError.code}
        onRetry={() => handleNoticeAction('resume')}
        onCopy={() => handleNoticeAction('copyError')}
        onBack={onBack}
      />
    )
  }
  if (blocked) return <StudioBlockedView onBack={onBack} />
  if (!loaded) return <StudioLoadingView />

  /** 匯出進行中不離開工作室（返回會中斷匯出的狀態顯示）：改用 Toast 提示 */
  const handleBack = requestBack

  const counts = chipCounts(state.doc.events)
  const eventCount = state.doc.events.filter((e) => !e.deleted).length
  const meta = [state.doc.video.width + '×' + state.doc.video.height, state.doc.video.codec.toUpperCase(), formatTime(duration), i18n.studio.meta.events.replace('{n}', String(eventCount))].join(' · ')

  return (
    <div className="studio">
      <StudioHeader
        title={baseName(videoPath)}
        meta={meta}
        statusDone={state.doc.analysis.status === 'done'}
        asideOpen={asideOpen}
        onBack={handleBack}
        onToggleAside={() => setAsideOpen((v) => !v)}
      />

      <div className="studio-body">
        <div className="studio-main">
          {shownNotice && <NoticeBar notice={shownNotice} busy={proxyState === 'generating'} onAction={handleNoticeAction} />}
          {mode.mode === 'project' && previewItem && (
            <ContextBanner
              index={previewIndex}
              label={`${formatTime(previewItem.start)}–${formatTime(previewItem.end)}`}
              sourceName={baseName(previewItem.source)}
              onBackToSource={backToSource}
            />
          )}

          <PlayerStage
            videoRef={videoRef}
            src={videoSrc}
            mode={mode.mode}
            modeLabel={modeLabel}
            spectating={spectatingNow}
            recentCounted={recentCounted}
            onTogglePlay={togglePlay}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onPlayingChange={handlePlayingChange}
            onEnded={handleVideoEnded}
            onError={handleVideoError}
          />

          <TransportBar
            playing={isPlaying}
            currentTime={currentTime}
            duration={duration}
            speed={speed}
            counts={counts}
            filter={state.filter}
            onTogglePlay={togglePlay}
            onCycleSpeed={cycleSpeed}
            onPrevEvent={() => seekEvent(-1)}
            onNextEvent={() => seekEvent(1)}
            onAddEvent={gAddEvent}
            mode={mode.mode}
            onQuick={handleQuickOrSplit}
            bladeMode={bladeMode}
            onAutoClip={() => setAutoClipOpen((v) => !v)}
            autoClipOpen={autoClipOpen}
            onToggleFilter={(t) => dispatch({ type: 'setFilter', filter: toggleFilter(state.filter, t) })}
          />

          <div className="studio-tl" data-editor-lock>
            <TimelineCanvas
              ref={tlRef}
              duration={duration}
              currentTime={currentTime}
              events={state.doc.events}
              spectating={state.doc.spectating}
              clips={state.clips}
              filter={state.filter}
              onSeek={seekTo}
              onScrubStart={startScrub}
              onScrubEnd={endScrub}
              onHoverSeek={hoverSeek}
              bladeMode={bladeMode && mode.mode === 'source'}
              onBladeModeChange={setBladeMode}
              onBladeRange={createBladeClip}
              onBladeTooShort={() => toast({ message: i18n.timeline.bladeTooShort })}
              disabled={overlayOpen || exporting}
              projectItem={sourceRange}
              onProjectTrim={trimSourceProjectItem}
              onSelectEvent={handleSelectEvent}
              seekBefore={cfg.before}
              onUpdateClip={(clip) => dispatch({ type: 'updateClip', clip })}
              currentEventId={activeEvent?.id}
              getPlayTime={sourcePlayTime}
              playing={isPlaying}
              followProject={mode.mode === 'project'}
            />
          </div>

          <ProjectTrack
            project={displayedProject}
            collapsed={projCollapsed}
            onToggleCollapsed={toggleProjCollapsed}
            selectedId={selProjId}
            onSelect={setSelProjId}
            currentId={mode.mode === 'project' && previewItem ? previewItem.id : null}
            progress={previewProgress}
            labelOf={labelOf}
            missingIds={missingItemIds}
            saveState={saveState}
            videoPath={videoPath}
            videoDuration={duration}
            onPlay={playProjectItem}
            onMissing={() => toast({ message: i18n.studio.track.missingToast })}
            onTrim={trimProjectItem}
            onMove={moveProjectItem}
            onRename={renameProject}
            onSplit={splitProjectAtPlayhead}
            onDuplicate={duplicateSelectedItem}
            onDelete={deleteSelectedItem}
            onUndo={undo}
            onRedo={redo}
            canUndo={canUndo}
            canRedo={canRedo}
            onNewProject={handleNewProjectConfirmed}
            onAddExternalVideo={handleAddExternalVideo}
            onExport={handleOpenExport}
            exportOpen={exportOpen}
            exportPercent={exporting ? (exportState.progress?.percent ?? 0) : null}
            onAddFromSource={addFirstSuggestion}
            onDialogOpenChange={setProjDlgOpen}
          />
        </div>

        {asideOpen && (
          <Aside
            hlCount={state.clips.length}
            locked={exporting}
          >
            <HighlightsTab
              clips={state.clips}
              events={state.doc.events}
              activeId={activeClipId}
              onActiveChange={setActiveClipId}
              onPreview={previewClip}
              onAccept={acceptClip}
              onSkip={skipClip}
              onRestore={restoreClip}
              onRemove={removeFromProject}
              onTuneParams={() => setAutoClipOpen(true)}
              project={displayedProject}
              onAddAll={addAllSuggestions}
            />
          </Aside>
        )}
      </div>

      {exportOpen && <ExportDrawer controller={exportCtl} project={project} base={exportBase} onClose={handleCloseExport} />}

      {autoClipOpen && (
        <AutoClipPopover
          defaults={cfg.autoclip}
          events={state.doc.events}
          duration={duration}
          onClose={() => setAutoClipOpen(false)}
          onApply={handleApplyAutoClip}
        />
      )}

      {addEventAt !== null && (
        <AddEventDialog
          time={addEventAt}
          onCancel={() => setAddEventAt(null)}
          onConfirm={(type) => {
            // 對話框開著時若進入專案模式（理論上不會）也不寫入來源文件
            if (guardCommand(modeRef.current.mode, 'addEvent') === 'allow') {
              dispatch({ type: 'addManualEvent', t: addEventAt, eventType: type })
            }
            setAddEventAt(null)
          }}
        />
      )}

      <div className="sr-only" aria-live="polite">
        {live}
      </div>
    </div>
  )
}
