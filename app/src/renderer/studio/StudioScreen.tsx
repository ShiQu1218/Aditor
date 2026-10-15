import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import '../styles/studio.css'
import '../styles/projectTrack.css'
import { AutoClipParams, CacheDoc, Clip, EngineEvent, EventType } from '../../shared/types'
import { formatTime, toCurrentTime } from '../../shared/time'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { viewerReducer, ViewerState } from '../viewer/state'
import { createClipAt, supercut } from '../timeline/clips'
import { nextEvent } from '../timeline/model'
import { TimelineCanvas, TimelineHandle } from '../timeline/TimelineCanvas'
import { useKeymap } from '../hooks/useShortcuts'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useToast } from '../shell/ToastHost'
import { useOverlay } from '../shell/OverlayHost'
import { useProject } from '../editor/ProjectProvider'
import { addItems, duplicateItem, moveItem, Project, ProjectItem, removeItem, splitItem, trimItem } from '../editor/project'
import { nextAfter } from '../editor/sequence'
import { ExportDialog } from '../components/ExportDialog'
import { RefreshCw, ZoomIn, ZoomOut } from '../components/icons'
import { checkSmooth, PlayabilityResult } from '../media/playability'
import { longFixtureRequested } from '../dev/fixture'
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
  nextSuggestion,
  removeProjectItems,
  shouldAutoPlace,
  toSuggestions
} from './highlights'
import { EventsTab } from './EventsTab'
import { HighlightsTab } from './HighlightsTab'
import { NoticeBar } from './NoticeBar'
import { PlayerStage } from './PlayerStage'
import { ProjectTrack } from './ProjectTrack'
import { StudioHeader } from './StudioHeader'
import { TransportBar } from './TransportBar'
import { chipCounts, nearCount, toggleFilter } from './chips'
import { createMode, currentItem, isForeign, reduceMode } from './mode'
import { NoticeAction, studioNotice, StudioNotice } from './notices'

interface StudioScreenProps {
  videoPath: string
  onBack: () => void
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
    profile: 'zh-TW',
    analysis: {
      status: 'done',
      progress_t: 0,
      engine_version: '0.1.0',
      templates_version: 'zh-TW@1',
      h_scale: 1.0
    },
    events: [],
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: ''
  }
}

function initViewerState(videoPath: string): ViewerState {
  return {
    doc: initialDoc(videoPath),
    selected: new Set<string>(),
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
export function StudioScreen({ videoPath, onBack }: StudioScreenProps): JSX.Element {
  const {
    project,
    apply,
    undo,
    redo,
    canUndo,
    canRedo,
    newProject,
    openFile,
    saveFile,
    saveState,
    missingItemIds
  } = useProject()
  const toast = useToast()
  const overlay = useOverlay()

  const videoRef = useRef<HTMLVideoElement>(null)
  const tlRef = useRef<TimelineHandle>(null)
  const [state, dispatch] = useReducer(viewerReducer, videoPath, initViewerState)
  const [mode, dispatchMode] = useReducer(reduceMode, videoPath, createMode)

  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1.0)
  const [tab, setTab] = useState<'hl' | 'ev'>('hl')
  const [asideOpen, setAsideOpen] = useState(true)
  const [addEventAt, setAddEventAt] = useState<number | null>(null)
  const [autoClipOpen, setAutoClipOpen] = useState(false)
  const [activeClipId, setActiveClipId] = useState<string | null>(null)
  /** 事件清單鍵盤游標（roving tabindex；↑↓ 移動） */
  const [evCursorId, setEvCursorId] = useState<string | null>(null)
  /** 專案軌選取片段（Alt+←/→、Ctrl+D、Delete、Enter 作用對象） */
  const [selProjId, setSelProjId] = useState<string | null>(null)
  /** 新專案對話框開啟中（暫停全域 keymap） */
  const [projDlgOpen, setProjDlgOpen] = useState(false)
  /** 設定快照（自動放置建議、浮層預設參數、專案軌收合）；尚未讀到時以 DEFAULT_SETTINGS 為準 */
  const [settings, setSettings] = useState<{
    autoSuggestOnOpen: boolean
    autoclip: AutoClipParams
    projectTrackCollapsed: 'auto' | boolean
  } | null>(null)

  const [reloadKey, setReloadKey] = useState(0)
  const [blocked, setBlocked] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [playability, setPlayability] = useState<PlayabilityResult>(DEFAULT_PLAYABILITY)
  const [proxyPath, setProxyPath] = useState<string | null>(null)
  const [proxyState, setProxyState] = useState<'none' | 'available' | 'generating'>('none')
  const [proxyDismissed, setProxyDismissed] = useState(false)
  const [live, setLive] = useState('')

  const duration = state.doc.video?.duration || 100
  const previewItem = currentItem(mode, project)
  const foreign = isForeign(mode, project)

  // 專案軌收合：'auto' 依視窗高度（≤800px 收合）；使用者切換後記進 settings
  const autoCollapse = useMediaQuery('(max-height: 800px)')
  const collapsePref = settings?.projectTrackCollapsed ?? DEFAULT_SETTINGS.projectTrackCollapsed
  const projCollapsed = collapsePref === 'auto' ? autoCollapse : collapsePref

  // 供 timeupdate 讀取（避免每幀重建 callback）
  const previewRef = useRef<{ item: ProjectItem | null }>({ item: null })
  previewRef.current = { item: previewItem }

  // 專案狀態的最新快照（Toast〔復原〕在觸發後才執行，不能閉包舊值）
  const projectRef = useRef(project)
  projectRef.current = project

  // 選取集合的最新快照（框選 Toast 的〔建立合輯〕在稍後才執行）
  const selectedRef = useRef(state.selected)
  selectedRef.current = state.selected

  // 自動放置建議每個工作階段只做一次（避免 autoclip 無結果時重複呼叫）
  const autoPlaced = useRef(false)

  /* ---------------- 載入（沿用 Viewer 的 cache.load／engine.analyze 與去抖儲存） ---------------- */

  useEffect(() => {
    let cancelled = false
    setBlocked(false)
    setAnalysisError(null)
    const load = async (): Promise<void> => {
      if (longFixtureRequested()) {
        const { buildLongDoc } = await import('../dev/longFixture')
        if (!cancelled) dispatch({ type: 'analysisResult', doc: buildLongDoc(videoPath) })
        return
      }
      const api = window.api
      if (api?.engine?.analyze) {
        try {
          const res = (await api.engine.analyze({ path: videoPath })) as CacheDoc | null
          if (cancelled) return
          if (res) {
            // 防禦：分析尚未完成（Library 已攔截，這裡再擋一次）
            if (res.analysis?.status !== 'done') {
              setBlocked(true)
            } else {
              dispatch({ type: 'analysisResult', doc: res })
              void checkSmooth(res.video).then((p) => {
                if (!cancelled) setPlayability(p)
              })
            }
          }
        } catch (err) {
          if (!cancelled) {
            console.error('Failed to analyze/load cache:', err)
            setAnalysisError(err instanceof Error ? err.message : 'analysis failed')
          }
        }
      }
      if (api?.proxy?.get) {
        try {
          const p: string | null = await api.proxy.get(videoPath)
          if (!cancelled && p) {
            setProxyPath(p)
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
  }, [videoPath, reloadKey])

  // dirty：1 秒去抖後寫回快取
  useEffect(() => {
    if (!state.dirty || !state.doc.cache_path) return
    const timer = setTimeout(async () => {
      await window.api?.cache?.save?.(state.doc)
    }, 1000)
    return () => clearTimeout(timer)
  }, [state.dirty, state.doc])

  /* ---------------- 設定與自動放置建議 ---------------- */

  // 讀取設定（自動放置開關、AI 預設參數與專案軌收合）；浮層與自動放置共用
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const api = window.api
      if (!api?.settings?.get) {
        setSettings({
          autoSuggestOnOpen: DEFAULT_SETTINGS.autoSuggestOnOpen,
          autoclip: DEFAULT_SETTINGS.autoclip,
          projectTrackCollapsed: DEFAULT_SETTINGS.projectTrackCollapsed
        })
        return
      }
      try {
        const s = await api.settings.get()
        if (cancelled) return
        const pref = s?.projectTrackCollapsed
        setSettings({
          autoSuggestOnOpen:
            typeof s?.autoSuggestOnOpen === 'boolean' ? s.autoSuggestOnOpen : DEFAULT_SETTINGS.autoSuggestOnOpen,
          autoclip: s?.autoclip ?? DEFAULT_SETTINGS.autoclip,
          projectTrackCollapsed:
            pref === true || pref === false || pref === 'auto' ? pref : DEFAULT_SETTINGS.projectTrackCollapsed
        })
      } catch {
        if (!cancelled) {
          setSettings({
            autoSuggestOnOpen: false,
            autoclip: DEFAULT_SETTINGS.autoclip,
            projectTrackCollapsed: DEFAULT_SETTINGS.projectTrackCollapsed
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 開啟影片自動放置 AI 建議（spec §3.2.6）：每個工作階段一次；分析結果未載入或引擎不可用時不消耗機會
  useEffect(() => {
    if (!settings || autoPlaced.current) return
    if (state.doc.events.length === 0) return
    if (!shouldAutoPlace(state.doc, settings)) return
    const api = window.api
    if (!api?.engine?.autoclip) return
    autoPlaced.current = true
    void (async () => {
      try {
        const res = await api.engine.autoclip({ events: state.doc.events, params: settings.autoclip, duration })
        if (Array.isArray(res?.clips) && res.clips.length > 0) {
          dispatch({ type: 'setAiClips', clips: toSuggestions(res.clips) })
          setTab('hl')
        }
      } catch (err) {
        console.error('Failed to auto-place AI suggestions:', err)
      }
    })()
  }, [settings, state.doc, duration])

  // 精華分頁開啟時確保有作用中卡片（roving tabindex 的第一站）
  useEffect(() => {
    if (tab !== 'hl') return
    setActiveClipId((prev) =>
      prev && state.clips.some((c) => c.id === prev) ? prev : nextSuggestion(state.clips, null, 1)
    )
  }, [tab, state.clips])

  // 事件分頁的 filter 後清單（鍵盤游標／Enter 跳轉共用）
  const evFiltered = useMemo(
    () => state.doc.events.filter((e) => state.filter.has(e.type as EventType)),
    [state.doc.events, state.filter]
  )

  // 事件分頁開啟時確保游標落在清單內（roving tabindex 的第一站）
  useEffect(() => {
    if (tab !== 'ev') return
    setEvCursorId((prev) => (prev && evFiltered.some((e) => e.id === prev) ? prev : evFiltered[0]?.id ?? null))
  }, [tab, evFiltered])

  /* ---------------- 播放控制 ---------------- */

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

  const seekTo = useCallback((t: number) => {
    const el = videoRef.current
    const clamped = Math.max(0, t)
    if (el) el.currentTime = toCurrentTime(clamped, 0)
    setCurrentTime(clamped)
  }, [])

  const backToSource = useCallback(() => {
    dispatchMode({ type: 'backToSource' })
  }, [])

  const seekBy = useCallback(
    (delta: number) => {
      if (mode.mode === 'project') dispatchMode({ type: 'seekSource' })
      const now = videoRef.current?.currentTime ?? currentTime
      seekTo(Math.max(0, Math.min(duration, now + delta)))
    },
    [mode.mode, currentTime, duration, seekTo]
  )

  const seekEvent = useCallback(
    (dir: 1 | -1) => {
      if (mode.mode === 'project') dispatchMode({ type: 'seekSource' })
      const ev = nextEvent(state.doc.events, currentTime, dir, state.filter)
      if (ev) seekTo(Math.max(0, ev.t - 8))
    },
    [mode.mode, state.doc.events, currentTime, state.filter, seekTo]
  )

  const handleSelectEvent = useCallback(
    (ev: { t: number }) => {
      if (mode.mode === 'project') dispatchMode({ type: 'seekSource' })
      seekTo(Math.max(0, ev.t - 8))
    },
    [mode.mode, seekTo]
  )

  // 播放頭時間：專案模式依序接續（跨影片續播），最後一段播完即暫停
  const handleTimeUpdate = useCallback((t: number) => {
    setCurrentTime(t)
    const item = previewRef.current.item
    if (!item) return
    const step = nextAfter(projectRef.current, item.id, t)
    if (step.kind === 'continue') return
    if (step.kind === 'next') dispatchMode({ type: 'playItem', item: step.item })
    else videoRef.current?.pause()
  }, [])

  // 進入片段預覽：載入後 seek 到片段起點並播放（spec §3.5）
  useEffect(() => {
    const el = videoRef.current
    if (!el || !previewItem) return
    const start = Math.max(0, previewItem.start)
    const run = (): void => {
      el.currentTime = toCurrentTime(start, 0)
      void el.play().catch(() => {})
    }
    if (el.readyState >= 1) {
      run()
      return
    }
    el.addEventListener('loadedmetadata', run, { once: true })
    return () => el.removeEventListener('loadedmetadata', run)
  }, [previewItem?.id, previewItem?.start])

  const videoSrc = useMemo(() => {
    const file = foreign && previewItem ? previewItem.source : proxyPath ?? videoPath
    return `file://${file.replace(/\\/g, '/')}`
  }, [foreign, previewItem, proxyPath, videoPath])

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
    return Math.max(0, Math.min(1, (currentTime - previewItem.start) / len))
  }, [previewItem, currentTime])

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

  const notice: StudioNotice | null = useMemo(() => {
    const base = studioNotice({
      analysis: analysisError ? 'error' : 'done',
      playability,
      proxyState,
      errorCode: analysisError ?? undefined
    })
    if (proxyDismissed && base?.id === 'proxy-suggest') return null
    return base
  }, [analysisError, playability, proxyState, proxyDismissed])

  const busyNotice: StudioNotice | null = useMemo(
    () =>
      proxyState === 'generating'
        ? { id: 'proxy-generating', kind: 'info', title: i18n.studio.notices.proxyBusy, text: '', actions: [] }
        : null,
    [proxyState]
  )
  const shownNotice = notice ?? busyNotice

  const handleGenerateProxy = useCallback(async (): Promise<void> => {
    setProxyState('generating')
    try {
      const p: string | null = await window.api?.proxy?.generate?.(videoPath)
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
  }, [videoPath])

  const handleNoticeAction = useCallback(
    (a: NoticeAction): void => {
      if (a === 'resume') {
        setAnalysisError(null)
        setReloadKey((k) => k + 1)
      } else if (a === 'copyError') {
        void navigator.clipboard?.writeText(analysisError ?? '').catch(() => {})
        toast({ message: i18n.studio.toast.copied })
      } else if (a === 'generateProxy') {
        void handleGenerateProxy()
      } else if (a === 'later') {
        setProxyDismissed(true)
      }
    },
    [analysisError, handleGenerateProxy, toast]
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

  /** 快速剪輯（Ctrl+Q，來源模式）：建立手動片段並同步加入專案（spec §3.6）。 */
  const handleQuickOrSplit = useCallback(() => {
    if (mode.mode === 'project') {
      splitProjectAtPlayhead()
      return
    }
    const clip = createClipAt(currentTime, 8, 4, duration)
    dispatch({ type: 'addClip', clip })
    setTab('hl')
    const res = acceptToProject(clip, videoPath, projectRef.current)
    if (res.added.length === 0) return
    apply(addItems(projectRef.current, res.added))
    toast({
      message: i18n.studio.toast.addedProject.replace('{sec}', String(Math.round(clip.end - clip.start))),
      action: {
        label: i18n.studio.toast.undo,
        run: () => {
          apply(res.undo(projectRef.current))
          dispatch({ type: 'removeClip', id: clip.id })
        }
      }
    })
  }, [mode.mode, splitProjectAtPlayhead, currentTime, duration, videoPath, apply, toast])

  /** 處理完目前建議後，把作用中卡片移到下一個建議（以處理前的清單計算）。 */
  const advanceActive = useCallback(
    (fromId: string) => {
      setActiveClipId(nextSuggestion(state.clips, fromId, 1))
    },
    [state.clips]
  )

  /** 預覽片段：退出專案模式並跳到片段起點。 */
  const previewClip = useCallback(
    (clip: Clip) => {
      if (mode.mode === 'project') dispatchMode({ type: 'seekSource' })
      seekTo(Math.max(0, clip.start))
    },
    [mode.mode, seekTo]
  )

  /** 加入建議（卡片／Enter）：加入專案、標記已加入、Toast〔復原〕。 */
  const acceptClip = useCallback(
    (clip: Clip) => {
      const res = acceptToProject(clip, videoPath, projectRef.current)
      if (res.added.length > 0) apply(addItems(projectRef.current, res.added))
      dispatch({ type: 'acceptClip', id: clip.id })
      toast({
        message: i18n.studio.toast.addedProject.replace('{sec}', String(Math.round(Math.max(0, clip.end - clip.start)))),
        action:
          res.added.length > 0
            ? { label: i18n.studio.toast.undo, run: () => apply(res.undo(projectRef.current)) }
            : undefined
      })
      advanceActive(clip.id)
    },
    [videoPath, apply, toast, advanceActive]
  )

  /** 略過建議（卡片／Delete）：標記已略過，Toast〔復原〕回到建議。 */
  const skipClip = useCallback(
    (clip: Clip) => {
      dispatch({ type: 'skipClip', id: clip.id })
      toast({
        message: i18n.studio.toast.skipped,
        action: { label: i18n.studio.toast.undo, run: () => dispatch({ type: 'restoreClip', id: clip.id }) }
      })
      advanceActive(clip.id)
    },
    [toast, advanceActive]
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
          run: () => {
            if (items.length > 0) apply(addItems(projectRef.current, items))
            dispatch(manual ? { type: 'addClip', clip } : { type: 'acceptClip', id: clip.id })
          }
        }
      })
    },
    [videoPath, apply, toast]
  )

  /** 全部加入（Ctrl+E／底欄）：所有待確認建議一次加入專案，單一 Toast〔復原〕。 */
  const addAllSuggestions = useCallback(() => {
    const suggested = state.clips.filter(isSuggested)
    if (suggested.length === 0) return
    let next: Project = projectRef.current
    const addedIds: string[] = []
    for (const c of suggested) {
      const res = acceptToProject(c, videoPath, next)
      if (res.added.length > 0) next = addItems(next, res.added)
      for (const it of res.added) addedIds.push(it.id)
    }
    apply(next)
    for (const c of suggested) dispatch({ type: 'acceptClip', id: c.id })
    const secs = Math.round(suggested.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0))
    toast({
      message: i18n.studio.toast.addedProject.replace('{sec}', String(secs)),
      action: {
        label: i18n.studio.toast.undo,
        run: () => {
          if (addedIds.length > 0) apply(removeProjectItems(projectRef.current, addedIds))
          for (const c of suggested) dispatch({ type: 'restoreClip', id: c.id })
        }
      }
    })
  }, [state.clips, videoPath, apply, toast])

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

  const handleToggleSelect = useCallback((id: string) => {
    dispatch({ type: 'setSelection', ids: [id], mode: 'toggle' })
  }, [])

  const clearSelection = useCallback(() => {
    dispatch({ type: 'setSelection', ids: [], mode: 'replace' })
  }, [])

  /** 建立合輯（Ctrl+M／底欄／框選 Toast）：勾選事件 → 片段 → 同步加入專案，單一 Toast〔復原〕。 */
  const runSupercut = useCallback(() => {
    const ids = selectedRef.current
    if (ids.size === 0) return
    const clips = supercut(
      state.doc.events.filter((e) => !e.deleted),
      ids,
      8,
      4,
      duration
    )
    if (clips.length === 0) return
    let next: Project = projectRef.current
    const addedIds: string[] = []
    for (const c of clips) {
      dispatch({ type: 'addClip', clip: c })
      const res = acceptToProject(c, videoPath, next)
      if (res.added.length > 0) next = addItems(next, res.added)
      for (const it of res.added) addedIds.push(it.id)
    }
    apply(next)
    dispatch({ type: 'setSelection', ids: [], mode: 'replace' })
    setTab('hl')
    const secs = Math.round(clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0))
    toast({
      message: i18n.studio.toast.addedProject.replace('{sec}', String(secs)),
      action: {
        label: i18n.studio.toast.undo,
        run: () => {
          if (addedIds.length > 0) apply(removeProjectItems(projectRef.current, addedIds))
          for (const c of clips) dispatch({ type: 'removeClip', id: c.id })
        }
      }
    })
  }, [state.doc.events, duration, videoPath, apply, toast])

  const handleDeleteSelected = useCallback(() => {
    const ids = [...state.selected]
    if (ids.length === 0) return
    for (const id of ids) dispatch({ type: 'deleteEvent', id })
    dispatch({ type: 'setSelection', ids: [], mode: 'replace' })
    toast({
      message: i18n.studio.toast.deletedEvents.replace('{n}', String(ids.length)),
      action: { label: i18n.studio.toast.undo, run: () => ids.forEach((id) => dispatch({ type: 'restoreEvent', id })) }
    })
  }, [state.selected, toast])

  const handleDeleteEvent = useCallback(
    (id: string) => {
      dispatch({ type: 'deleteEvent', id })
      if (selectedRef.current.has(id)) {
        dispatch({
          type: 'setSelection',
          ids: [...selectedRef.current].filter((x) => x !== id),
          mode: 'replace'
        })
      }
      toast({
        message: i18n.studio.toast.deletedEvents.replace('{n}', '1'),
        action: { label: i18n.studio.toast.undo, run: () => dispatch({ type: 'restoreEvent', id }) }
      })
    },
    [toast]
  )

  /** 三態變更：先套用 override，再呼叫引擎 derive 重新推導 counted 與原因；成功時 Toast。 */
  const handleSetOverride = useCallback(
    (id: string, value: boolean | null) => {
      dispatch({ type: 'setOverride', id, value })
      const api = window.api
      if (!api?.engine?.derive) return
      const events = state.doc.events.map((e) => (e.id === id ? { ...e, counted_override: value } : e))
      void (async () => {
        try {
          const res = (await api.engine.derive({ events, spectating: state.doc.spectating })) as {
            events: EngineEvent[]
          } | null
          if (res?.events) {
            dispatch({ type: 'derived', events: res.events })
            toast({ message: i18n.studio.toast.derived })
          }
        } catch (err) {
          console.error('Failed to derive counted reasons:', err)
        }
      })()
    },
    [state.doc.events, state.doc.spectating, toast]
  )

  /** 框選（時間軸拖曳空白）：Shift／Ctrl＝加選，否則取代；完成 Toast〔建立合輯〕。 */
  const handleBoxSelect = useCallback(
    (ids: string[], t1: number, t2: number, additive: boolean) => {
      dispatch({ type: 'setSelection', ids, mode: additive ? 'add' : 'replace' })
      setTab('ev')
      toast({
        message: i18n.studio.toast.boxSelected
          .replace('{n}', String(ids.length))
          .replace('{range}', `${formatTime(t1)}–${formatTime(t2)}`),
        action: { label: i18n.studio.ev.supercut, run: runSupercut }
      })
    },
    [toast, runSupercut]
  )

  /** ↑↓：精華分頁移動建議卡；事件分頁移動游標（到底環繞）。 */
  const moveListCursor = useCallback(
    (dir: 1 | -1) => {
      if (tab === 'hl') {
        setActiveClipId((prev) => nextSuggestion(state.clips, prev, dir))
        return
      }
      if (evFiltered.length === 0) return
      setEvCursorId((prev) => {
        const at = prev ? evFiltered.findIndex((e) => e.id === prev) : -1
        const base = at >= 0 ? at : dir === 1 ? -1 : 0
        const i = (((base + dir) % evFiltered.length) + evFiltered.length) % evFiltered.length
        return evFiltered[i].id
      })
    },
    [tab, state.clips, evFiltered]
  )

  const handleOpenExport = useCallback(() => {
    overlay.open(<ExportDialog project={project} onClose={overlay.close} />)
  }, [overlay, project])

  /** 浮層套用：只取代 suggested／skipped 的 AI 片段（保留已加入與手動）並寫回快取。 */
  const handleApplyAutoClip = useCallback(
    (clips: Clip[]) => {
      dispatch({ type: 'applyClips', clips: applyAutoClip(state.clips, clips) })
      setTab('hl')
    },
    [state.clips]
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

  /** 播放片段（卡片點擊／Enter）：缺失來源只 Toast，不進專案模式。 */
  const playProjectItem = useCallback(
    (item: ProjectItem) => {
      if (missingItemIds.has(item.id)) {
        toast({ message: i18n.studio.track.missingToast })
        return
      }
      dispatchMode({ type: 'playItem', item })
    },
    [missingItemIds, toast]
  )

  /** 把手／步進微調：同影片夾在影片長度內；其他來源無長度資訊不設上界。 */
  const trimProjectItem = useCallback(
    (id: string, edge: 'start' | 'end', t: number) => {
      const item = projectRef.current.items.find((i) => i.id === id)
      const sameVideo = item ? normPath(item.source) === normPath(videoPath) : true
      apply(trimItem(projectRef.current, id, edge, t, sameVideo ? duration : undefined))
    },
    [apply, videoPath, duration]
  )

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
    apply(removeItem(projectRef.current, id))
    setSelProjId(null)
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

  /** 〔新專案〕：空專案不動作；有片段時開對話框（spec §3.7）。 */
  const requestNewProject = useCallback(() => {
    if (projectRef.current.items.length === 0) return
    setProjDlgOpen(true)
  }, [])

  /** 對話框確認：saveFirst＝先另存檔案（取消則中止）。 */
  const handleNewProjectConfirmed = useCallback(
    (saveFirst: boolean) => {
      void (async () => {
        if (saveFirst) {
          const saved = await saveFile()
          if (!saved) return
        }
        newProject()
        setSelProjId(null)
        prevItemCount.current = 0
        toast({ message: i18n.studio.toast.newProject })
      })()
    },
    [saveFile, newProject, toast]
  )

  /** 另存檔案（Ctrl+S／軌頭）：成功才 Toast（顯示檔名）。 */
  const handleSaveProjectFile = useCallback(() => {
    void (async () => {
      const saved = await saveFile()
      if (saved) toast({ message: i18n.studio.toast.savedAs.replace('{name}', baseName(saved)) })
    })()
  }, [saveFile, toast])

  /** ＋從來源加入：加入第一段待確認建議（mock 行為）；沒有時 Toast。 */
  const addFirstSuggestion = useCallback(() => {
    const clip = state.clips.find(isSuggested)
    if (clip) acceptClip(clip)
    else toast({ message: i18n.studio.toast.noSuggestions })
  }, [state.clips, acceptClip, toast])

  /* ---------------- keymap（spec §3.2.7） ---------------- */

  useKeymap(
    {
      play: togglePlay,
      speed: cycleSpeed,
      prevEvent: () => seekEvent(-1),
      nextEvent: () => seekEvent(1),
      seekBack: () => seekBy(-5),
      seekFwd: () => seekBy(5),
      zoomIn: () => tlRef.current?.zoomIn(),
      zoomOut: () => tlRef.current?.zoomOut(),
      zoomReset: () => tlRef.current?.zoomReset(),
      quickOrSplit: handleQuickOrSplit,
      addEvent: () => setAddEventAt(videoRef.current?.currentTime ?? currentTime),
      supercut: runSupercut,
      addAllToProject: addAllSuggestions,
      acceptSuggestion: handleAcceptSuggestion,
      skipSuggestion: handleSkipSuggestion,
      listPrev: () => moveListCursor(-1),
      listNext: () => moveListCursor(1),
      deleteSelectedEvents: handleDeleteSelected,
      seekSelectedEvent: () => {
        const id = [...state.selected][0]
        const ev =
          state.doc.events.find((e) => e.id === id) ?? evFiltered.find((e) => e.id === evCursorId)
        if (ev) handleSelectEvent(ev)
      },
      playItem: playSelectedItem,
      deleteProjectItem: deleteSelectedItem,
      duplicateItem: duplicateSelectedItem,
      moveItemLeft: () => shiftSelectedItem(-1),
      moveItemRight: () => shiftSelectedItem(1),
      selectPrevItem: () => selectProjectItem(-1),
      selectNextItem: () => selectProjectItem(1),
      undo,
      redo,
      saveProjectFile: handleSaveProjectFile,
      openExport: handleOpenExport,
      toggleAside: () => setAsideOpen((v) => !v),
      backToSource,
      closeOverlay: clearSelection
    },
    { screen: 'studio', mode: mode.mode, enabled: addEventAt === null && !autoClipOpen && !projDlgOpen }
  )

  /* ---------------- aria-live（朗讀目前事件／選取數） ---------------- */

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

  const prevSelectedCount = useRef(0)
  useEffect(() => {
    if (state.selected.size === prevSelectedCount.current) return
    prevSelectedCount.current = state.selected.size
    setLive(i18n.studio.live.selected.replace('{n}', String(state.selected.size)))
  }, [state.selected.size])

  /* ---------------- render ---------------- */

  if (blocked) {
    return (
      <div className="studio-blocked" role="alert">
        <p>{i18n.studio.openBlocked}</p>
        <button type="button" className="btn-ghost" onClick={onBack}>
          {i18n.studio.back}
        </button>
      </div>
    )
  }

  const counts = chipCounts(state.doc.events)
  const eventCount = state.doc.events.filter((e) => !e.deleted).length
  const meta = [state.doc.video.width + '×' + state.doc.video.height, state.doc.video.codec.toUpperCase(), formatTime(duration), i18n.studio.meta.events.replace('{n}', String(eventCount))].join(' · ')

  return (
    <div className="studio">
      <StudioHeader
        title={baseName(videoPath)}
        meta={meta}
        statusDone={state.doc.analysis.status === 'done'}
        mode={mode.mode}
        exportCount={project.items.length}
        asideOpen={asideOpen}
        onBack={onBack}
        onAutoClip={() => setAutoClipOpen((v) => !v)}
        onQuick={handleQuickOrSplit}
        onExport={handleOpenExport}
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
            onPlayingChange={setIsPlaying}
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
            onAddEvent={() => setAddEventAt(videoRef.current?.currentTime ?? currentTime)}
            onToggleFilter={(t) => dispatch({ type: 'setFilter', filter: toggleFilter(state.filter, t) })}
          />

          <div className={`studio-tl${foreign ? ' grayed' : ''}`}>
            <TimelineCanvas
              ref={tlRef}
              duration={duration}
              currentTime={currentTime}
              events={state.doc.events}
              spectating={state.doc.spectating}
              clips={state.clips}
              filter={state.filter}
              onSeek={seekTo}
              onSelectEvent={handleSelectEvent}
              onUpdateClip={(clip) => dispatch({ type: 'updateClip', clip })}
              selected={state.selected}
              currentEventId={activeEvent?.id}
              onToggleSelect={handleToggleSelect}
              onBoxSelect={handleBoxSelect}
              getPlayTime={() => videoRef.current?.currentTime ?? 0}
              playing={isPlaying}
              onPlayToggle={togglePlay}
            />
            <div className="tl-zoom">
              <button type="button" className="icon-btn" aria-label={i18n.studio.transport.zoomOut} onClick={() => tlRef.current?.zoomOut()}>
                <ZoomOut className="ic" />
              </button>
              <button type="button" className="icon-btn" aria-label={i18n.studio.transport.zoomIn} onClick={() => tlRef.current?.zoomIn()}>
                <ZoomIn className="ic" />
              </button>
              <button type="button" className="icon-btn" aria-label={i18n.studio.transport.zoomReset} onClick={() => tlRef.current?.zoomReset()}>
                <RefreshCw className="ic" />
              </button>
            </div>
          </div>

          <ProjectTrack
            project={project}
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
            onOpenFile={() => void openFile()}
            onSaveFile={handleSaveProjectFile}
            onAddFromSource={addFirstSuggestion}
            onDialogOpenChange={setProjDlgOpen}
          />
        </div>

        {asideOpen && (
          <Aside
            tab={tab}
            onTab={setTab}
            hlCount={state.clips.length}
            evCount={eventCount}
            grayed={foreign}
          >
            {tab === 'hl' ? (
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
                project={project}
                onAddAll={addAllSuggestions}
              />
            ) : (
              <EventsTab
                events={state.doc.events}
                filter={state.filter}
                selected={state.selected}
                currentId={activeEvent?.id ?? null}
                cursorId={evCursorId}
                onCursorChange={setEvCursorId}
                onSeek={handleSelectEvent}
                onToggleSelect={handleToggleSelect}
                onSetOverride={handleSetOverride}
                onDelete={handleDeleteEvent}
                onClearSelection={clearSelection}
                onSupercut={runSupercut}
              />
            )}
          </Aside>
        )}
      </div>

      {autoClipOpen && (
        <AutoClipPopover
          defaults={settings?.autoclip ?? DEFAULT_SETTINGS.autoclip}
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
            dispatch({ type: 'addManualEvent', t: addEventAt, eventType: type })
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
