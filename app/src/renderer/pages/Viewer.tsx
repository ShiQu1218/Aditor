import React, { useReducer, useEffect, useRef, useState, useCallback } from 'react'
import { viewerReducer, ViewerState } from '../viewer/state'
import { TimelineCanvas } from '../timeline/TimelineCanvas'
import { EventList } from '../components/EventList'
import { ClipList } from '../components/ClipList'
import { EventTypeFilter } from '../components/EventTypeFilter'
import { AutoClipDialog } from '../components/AutoClipDialog'
import { useShortcuts } from '../hooks/useShortcuts'
import { createClipAt, supercut } from '../timeline/clips'
import { nextEvent } from '../timeline/model'
import { formatTime, toCurrentTime } from '../../shared/time'
import { AutoClipParams, CacheDoc, Clip, EngineEvent, EventType } from '../../shared/types'
import { i18n } from '../i18n/zh-TW'

interface ViewerPageProps {
  videoPath: string
  onBack: () => void
  onSendToProject?: (clips: Clip[]) => void
}

const DEFAULT_FILTER = new Set<EventType>([
  'knock',
  'assist_knock',
  'assist_elim',
  'elim',
  'squad_wipe'
])

export function ViewerPage({ videoPath, onBack, onSendToProject }: ViewerPageProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(1.0)
  const [activeTab, setActiveTab] = useState<'events' | 'clips'>('events')
  const [isAutoClipOpen, setIsAutoClipOpen] = useState(false)
  const [showAddEventModal, setShowAddEventModal] = useState(false)
  const [addEventType, setAddEventType] = useState<EventType>('knock')
  const [proxyPath, setProxyPath] = useState<string | null>(null)
  const [suggestProxy, setSuggestProxy] = useState(false)
  const [isGeneratingProxy, setIsGeneratingProxy] = useState(false)

  const initialDoc: CacheDoc = {
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

  const [state, dispatch] = useReducer(viewerReducer, {
    doc: initialDoc,
    selected: new Set<string>(),
    filter: DEFAULT_FILTER,
    clips: [],
    dirty: false
  })

  // Load cache on mount
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      // @ts-ignore
      if (window.api?.engine?.analyze) {
        try {
          // @ts-ignore
          const res = await window.api.engine.analyze({ path: videoPath })
          if (!cancelled && res) {
            dispatch({ type: 'analysisResult', doc: res })
          }
        } catch (err) {
          console.error('Failed to analyze/load cache:', err)
        }
      }

      // Check for proxy file
      // @ts-ignore
      if (window.api?.proxy?.get) {
        // @ts-ignore
        const p = await window.api.proxy.get(videoPath)
        if (!cancelled && p) {
          setProxyPath(p)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [videoPath])

  const handleGenerateProxy = async () => {
    setIsGeneratingProxy(true)
    try {
      // @ts-ignore
      const p = await window.api?.proxy?.generate?.(videoPath)
      if (p) {
        setProxyPath(p)
        setSuggestProxy(false)
      }
    } catch (err) {
      console.error('Failed to generate proxy:', err)
    } finally {
      setIsGeneratingProxy(false)
    }
  }

  // Debounced auto-save when dirty
  useEffect(() => {
    if (!state.dirty || !state.doc.cache_path) return
    const timer = setTimeout(async () => {
      // @ts-ignore
      if (window.api?.cache?.save) {
        // @ts-ignore
        await window.api.cache.save(state.doc)
      }
    }, 1000)
    return () => clearTimeout(timer)
  }, [state.dirty, state.doc])

  const duration = state.doc.video?.duration || 100

  // Playback control helpers
  const togglePlay = useCallback(() => {
    if (!videoRef.current) return
    if (videoRef.current.paused) {
      videoRef.current.play()
      setIsPlaying(true)
    } else {
      videoRef.current.pause()
      setIsPlaying(false)
    }
  }, [])

  const cycleSpeed = useCallback(() => {
    const speeds = [1.0, 0.5, 0.25, 2.0]
    const nextIdx = (speeds.indexOf(speed) + 1) % speeds.length
    const nextSpeed = speeds[nextIdx]
    setSpeed(nextSpeed)
    if (videoRef.current) {
      videoRef.current.playbackRate = nextSpeed
    }
  }, [speed])

  const seekTo = useCallback((t: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = toCurrentTime(t, 0)
      setCurrentTime(t)
    }
  }, [])

  const handlePrevEvent = useCallback(() => {
    const prev = nextEvent(state.doc.events, currentTime, -1, state.filter)
    if (prev) {
      seekTo(Math.max(0, prev.t - 8))
    }
  }, [state.doc.events, currentTime, state.filter, seekTo])

  const handleNextEvent = useCallback(() => {
    const next = nextEvent(state.doc.events, currentTime, 1, state.filter)
    if (next) {
      seekTo(Math.max(0, next.t - 8))
    }
  }, [state.doc.events, currentTime, state.filter, seekTo])

  const handleQuickClip = useCallback(() => {
    const clip = createClipAt(currentTime, 8, 4, duration)
    dispatch({ type: 'addClip', clip })
  }, [currentTime, duration])

  const handleCreateSupercut = useCallback(() => {
    if (state.selected.size === 0) return
    const newClips = supercut(state.doc.events, state.selected, 8, 4, duration)
    for (const c of newClips) {
      dispatch({ type: 'addClip', clip: c })
    }
    setActiveTab('clips')
  }, [state.selected, state.doc.events, duration])

  const handleAutoClipGenerate = useCallback(
    async (params: AutoClipParams) => {
      // @ts-ignore
      if (window.api?.engine?.autoclip) {
        try {
          // @ts-ignore
          const res = await window.api.engine.autoclip({
            events: state.doc.events,
            params,
            duration
          })
          if (res?.clips) {
            dispatch({ type: 'setAiClips', clips: res.clips })
            setActiveTab('clips')
          }
        } catch (err) {
          console.error('Failed to run autoclip:', err)
        }
      }
    },
    [state.doc.events, duration]
  )

  const handleAddManualEventConfirm = () => {
    dispatch({ type: 'addManualEvent', t: currentTime, eventType: addEventType })
    setShowAddEventModal(false)
  }

  // Bind shortcuts
  useShortcuts({
    onPlayPause: togglePlay,
    onCycleSpeed: cycleSpeed,
    onPrevEvent: handlePrevEvent,
    onNextEvent: handleNextEvent,
    onQuickClip: handleQuickClip,
    onAddEvent: () => setShowAddEventModal(true),
    onSendToProject: () => onSendToProject?.(state.clips)
  })

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: '#18191f',
        color: '#fff',
        overflow: 'hidden'
      }}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid #262833',
          backgroundColor: '#20222b'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onBack}
            style={{
              padding: '6px 12px',
              backgroundColor: '#303340',
              border: 'none',
              borderRadius: 4,
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13
            }}
          >
            ← {i18n.viewer.back}
          </button>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {videoPath.split(/[/\\]/).pop()}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setIsAutoClipOpen(true)}
            style={{
              padding: '6px 12px',
              backgroundColor: '#38bdf8',
              color: '#000',
              fontWeight: 600,
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13
            }}
          >
            {i18n.viewer.autoClip}
          </button>
          <button
            onClick={handleCreateSupercut}
            disabled={state.selected.size === 0}
            style={{
              padding: '6px 12px',
              backgroundColor: state.selected.size > 0 ? '#e13b30' : '#303340',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: state.selected.size > 0 ? 'pointer' : 'default',
              fontSize: 13
            }}
          >
            {i18n.viewer.createSupercut} ({state.selected.size})
          </button>
          <button
            onClick={() => onSendToProject?.(state.clips)}
            disabled={state.clips.length === 0}
            style={{
              padding: '6px 12px',
              backgroundColor: state.clips.length > 0 ? '#22c55e' : '#303340',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: state.clips.length > 0 ? 'pointer' : 'default',
              fontSize: 13
            }}
          >
            {i18n.viewer.sendToProject}
          </button>
        </div>
      </div>

      {/* Main Content: Player on Left, Sidebar on Right */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left: Video + Timeline + Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, padding: 16, gap: 12 }}>
          {/* Proxy suggestion banner */}
          {suggestProxy && !proxyPath && (
            <div
              style={{
                backgroundColor: 'rgba(56, 189, 248, 0.15)',
                border: '1px solid #38bdf8',
                borderRadius: 6,
                padding: '8px 12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 13
              }}
            >
              <span>{i18n.viewer.suggestProxyDesc}</span>
              <button
                onClick={handleGenerateProxy}
                disabled={isGeneratingProxy}
                style={{
                  padding: '4px 10px',
                  backgroundColor: '#38bdf8',
                  color: '#000',
                  border: 'none',
                  borderRadius: 4,
                  cursor: isGeneratingProxy ? 'default' : 'pointer',
                  fontWeight: 600,
                  fontSize: 12
                }}
              >
                {isGeneratingProxy ? '產生中...' : i18n.viewer.generateProxy}
              </button>
            </div>
          )}

          {/* Video player box */}
          <div
            style={{
              flex: 1,
              backgroundColor: '#0f1015',
              borderRadius: 8,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative'
            }}
          >
            <video
              ref={videoRef}
              src={`file://${(proxyPath || videoPath).replace(/\\/g, '/')}`}
              onTimeUpdate={() => {
                if (videoRef.current) {
                  setCurrentTime(videoRef.current.currentTime)
                }
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onClick={togglePlay}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </div>

          {/* Controls and Current Time */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={togglePlay}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  backgroundColor: '#e13b30',
                  border: 'none',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 16
                }}
              >
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button
                onClick={cycleSpeed}
                style={{
                  padding: '4px 8px',
                  backgroundColor: '#262833',
                  border: '1px solid #363945',
                  color: '#38bdf8',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600
                }}
              >
                {speed}x
              </button>
              <span style={{ fontSize: 13, fontFamily: 'monospace' }}>
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleQuickClip}
                style={{
                  padding: '5px 10px',
                  backgroundColor: '#262833',
                  border: '1px solid #363945',
                  color: '#fff',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12
                }}
              >
                {i18n.viewer.quickClip}
              </button>
              <button
                onClick={() => setShowAddEventModal(true)}
                style={{
                  padding: '5px 10px',
                  backgroundColor: '#262833',
                  border: '1px solid #363945',
                  color: '#fff',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12
                }}
              >
                + {i18n.viewer.addEvent}
              </button>
            </div>
          </div>

          {/* Timeline Canvas */}
          <TimelineCanvas
            duration={duration}
            currentTime={currentTime}
            events={state.doc.events}
            spectating={state.doc.spectating}
            clips={state.clips}
            filter={state.filter}
            onSeek={seekTo}
            onSelectEvent={(ev) => seekTo(Math.max(0, ev.t - 8))}
            onUpdateClip={(clip) => dispatch({ type: 'updateClip', clip })}
          />
        </div>

        {/* Right: Sidebar */}
        <div
          style={{
            width: 340,
            borderLeft: '1px solid #262833',
            backgroundColor: '#1b1d26',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #262833' }}>
            <button
              onClick={() => setActiveTab('events')}
              style={{
                flex: 1,
                padding: '12px 0',
                border: 'none',
                backgroundColor: activeTab === 'events' ? '#22242e' : 'transparent',
                color: activeTab === 'events' ? '#38bdf8' : '#8c90a4',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                borderBottom: activeTab === 'events' ? '2px solid #38bdf8' : 'none'
              }}
            >
              {i18n.viewer.events} ({state.doc.events.length})
            </button>
            <button
              onClick={() => setActiveTab('clips')}
              style={{
                flex: 1,
                padding: '12px 0',
                border: 'none',
                backgroundColor: activeTab === 'clips' ? '#22242e' : 'transparent',
                color: activeTab === 'clips' ? '#38bdf8' : '#8c90a4',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                borderBottom: activeTab === 'clips' ? '2px solid #38bdf8' : 'none'
              }}
            >
              {i18n.viewer.clips} ({state.clips.length})
            </button>
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden' }}>
            {activeTab === 'events' ? (
              <>
                <EventTypeFilter
                  filter={state.filter}
                  onChange={(f) => dispatch({ type: 'setFilter', filter: f })}
                />
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  <EventList
                    events={state.doc.events}
                    selected={state.selected}
                    filter={state.filter}
                    onSelectEvent={(ev) => seekTo(Math.max(0, ev.t - 8))}
                    onToggleSelect={(id) => dispatch({ type: 'toggleSelectEvent', id })}
                    onToggleOverride={(id, val) => dispatch({ type: 'setOverride', id, value: val })}
                    onDeleteEvent={(id) => dispatch({ type: 'deleteEvent', id })}
                  />
                </div>
              </>
            ) : (
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <ClipList
                  clips={state.clips}
                  onPlayClip={(clip) => seekTo(clip.start)}
                  onRemoveClip={(id) => dispatch({ type: 'removeClip', id })}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* AutoClip Dialog */}
      <AutoClipDialog
        isOpen={isAutoClipOpen}
        onClose={() => setIsAutoClipOpen(false)}
        onGenerate={handleAutoClipGenerate}
      />

      {/* Add Manual Event Modal */}
      {showAddEventModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}
          onClick={() => setShowAddEventModal(false)}
        >
          <div
            style={{
              backgroundColor: '#262833',
              padding: 20,
              borderRadius: 8,
              width: 300,
              border: '1px solid #363945',
              color: '#fff'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 style={{ margin: '0 0 12px' }}>於目前播放頭新增事件 ({formatTime(currentTime)})</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {(['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe'] as const).map((t) => (
                <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input
                    type="radio"
                    name="evType"
                    checked={addEventType === t}
                    onChange={() => setAddEventType(t)}
                  />
                  <span>
                    {t === 'knock'
                      ? '擊倒'
                      : t === 'assist_knock'
                      ? '助攻擊倒'
                      : t === 'assist_elim'
                      ? '助攻消滅'
                      : t === 'elim'
                      ? '已消滅'
                      : '小隊抹殺'}
                  </span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setShowAddEventModal(false)}
                style={{ padding: '6px 12px', border: '1px solid #363945', backgroundColor: 'transparent', color: '#fff', borderRadius: 4, cursor: 'pointer' }}
              >
                取消
              </button>
              <button
                onClick={handleAddManualEventConfirm}
                style={{ padding: '6px 12px', border: 'none', backgroundColor: '#e13b30', color: '#fff', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}
              >
                新增
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
