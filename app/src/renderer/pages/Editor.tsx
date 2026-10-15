import React, { useState, useEffect, useRef } from 'react'
import {
  Project,
  ProjectItem,
  createProject,
  addItems,
  removeItem,
  splitItem,
  duplicateItem,
  moveItem,
  trimItem,
  totalDuration,
  serializeProject,
  deserializeProject
} from '../editor/project'
import { History } from '../editor/history'
import { formatTime } from '../../shared/time'
import { ExportDialog } from '../components/ExportDialog'

interface EditorPageProps {
  initialProject?: Project
  onBack: () => void
  onOpenExport?: (project: Project) => void
}

export const EditorPage: React.FC<EditorPageProps> = ({
  initialProject,
  onBack,
  onOpenExport
}) => {
  const [history] = useState(() => new History<Project>(initialProject || createProject()))
  const [project, setProject] = useState<Project>(history.current)
  const [showExportModal, setShowExportModal] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(
    project.items.length > 0 ? project.items[0].id : null
  )

  // Playback state
  const [activeItemIndex, setActiveItemIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [sourceTime, setSourceTime] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)

  const applyProjectUpdate = (newProject: Project) => {
    history.push(newProject)
    setProject(newProject)
  }

  const handleUndo = () => {
    if (history.canUndo) {
      setProject(history.undo())
    }
  }

  const handleRedo = () => {
    if (history.canRedo) {
      setProject(history.redo())
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        handleUndo()
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')
      ) {
        e.preventDefault()
        handleRedo()
      } else if (e.code === 'Space') {
        const target = e.target as HTMLElement
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          e.preventDefault()
          togglePlay()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [history])

  // Sync active item when items change
  const currentItem = project.items[activeItemIndex] as ProjectItem | undefined

  useEffect(() => {
    if (currentItem && videoRef.current) {
      if (videoRef.current.src !== `file://${currentItem.source}`) {
        videoRef.current.src = `file://${currentItem.source}`
      }
      videoRef.current.currentTime = currentItem.start
      setSourceTime(currentItem.start)
    }
  }, [activeItemIndex, currentItem?.source])

  const togglePlay = () => {
    if (!videoRef.current) return
    if (isPlaying) {
      videoRef.current.pause()
      setIsPlaying(false)
    } else {
      videoRef.current.play().catch(console.error)
      setIsPlaying(true)
    }
  }

  const handleTimeUpdate = () => {
    if (!videoRef.current || !currentItem) return
    const cur = videoRef.current.currentTime
    setSourceTime(cur)

    if (cur >= currentItem.end) {
      if (activeItemIndex < project.items.length - 1) {
        setActiveItemIndex((prev) => prev + 1)
      } else {
        videoRef.current.pause()
        setIsPlaying(false)
        videoRef.current.currentTime = currentItem.end
      }
    }
  }

  const handleSplit = () => {
    if (!currentItem) return
    const splitT = sourceTime
    const next = splitItem(project, currentItem.id, splitT)
    if (next !== project) {
      applyProjectUpdate(next)
    }
  }

  const handleDuplicate = (id: string) => {
    applyProjectUpdate(duplicateItem(project, id))
  }

  const handleDelete = (id: string) => {
    applyProjectUpdate(removeItem(project, id))
    if (selectedId === id) {
      setSelectedId(null)
    }
  }

  const handleMove = (id: string, dir: -1 | 1) => {
    const idx = project.items.findIndex((item) => item.id === id)
    if (idx !== -1) {
      applyProjectUpdate(moveItem(project, id, idx + dir))
    }
  }

  const handleSaveProject = async () => {
    if (!window.api?.project) return
    const filePath = await window.api.project.showSaveDialog(`${project.name}.apexproj.json`)
    if (filePath) {
      await window.api.project.save(filePath, serializeProject(project))
    }
  }

  const handleOpenProject = async () => {
    if (!window.api?.project) return
    const filePath = await window.api.project.showOpenDialog()
    if (filePath) {
      const raw = await window.api.project.load(filePath)
      if (raw) {
        try {
          const loaded = deserializeProject(raw)
          applyProjectUpdate(loaded)
        } catch (err) {
          alert('開啟專案失敗: ' + (err as Error).message)
        }
      }
    }
  }

  const duration = totalDuration(project)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#121316', color: '#fff' }}>
      {/* Top Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid #2a2b30', background: '#18191f' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} style={{ background: '#2c2d35', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer' }}>
            ← 返回影片庫
          </button>
          <input
            type="text"
            value={project.name}
            onChange={(e) => applyProjectUpdate({ ...project, name: e.target.value })}
            style={{ background: '#25262c', border: '1px solid #3b3d45', color: '#fff', padding: '6px 10px', borderRadius: 4, fontWeight: 'bold' }}
          />
          <span style={{ fontSize: 13, color: '#909296' }}>
            片段數: {project.items.length} ｜ 總長度: {formatTime(duration)}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={handleUndo}
            disabled={!history.canUndo}
            title="復原 (Ctrl+Z)"
            style={{ background: '#2c2d35', color: history.canUndo ? '#fff' : '#666', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: history.canUndo ? 'pointer' : 'default' }}
          >
            復原 (Undo)
          </button>
          <button
            onClick={handleRedo}
            disabled={!history.canRedo}
            title="重做 (Ctrl+Y)"
            style={{ background: '#2c2d35', color: history.canRedo ? '#fff' : '#666', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: history.canRedo ? 'pointer' : 'default' }}
          >
            重做 (Redo)
          </button>
          <button
            onClick={handleOpenProject}
            style={{ background: '#2c2d35', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer' }}
          >
            開啟專案
          </button>
          <button
            onClick={handleSaveProject}
            style={{ background: '#2c2d35', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer' }}
          >
            儲存專案
          </button>
          <button
            onClick={() => {
              setShowExportModal(true)
              onOpenExport?.(project)
            }}
            style={{ background: '#228be6', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 16px', fontWeight: 'bold', cursor: 'pointer' }}
          >
            匯出專案...
          </button>
        </div>
      </div>

      {/* Main Preview Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#000', position: 'relative' }}>
        {project.items.length === 0 ? (
          <div style={{ color: '#888', fontSize: 16 }}>專案中無任何片段，請先從檢視器匯入或加入片段</div>
        ) : (
          <video
            ref={videoRef}
            onTimeUpdate={handleTimeUpdate}
            onEnded={() => setIsPlaying(false)}
            onClick={togglePlay}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        )}

        {/* Video overlay controls */}
        {currentItem && (
          <div style={{ position: 'absolute', bottom: 16, display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(0,0,0,0.7)', padding: '6px 14px', borderRadius: 20 }}>
            <button onClick={togglePlay} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16 }}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <span style={{ fontSize: 13, color: '#ddd' }}>
              片段 {activeItemIndex + 1}/{project.items.length} ({formatTime(sourceTime)} / {formatTime(currentItem.end)})
            </span>
            <button onClick={handleSplit} style={{ background: '#ff922b', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>
              在此處分割
            </button>
          </div>
        )}
      </div>

      {/* Timeline & Segments Strip */}
      <div style={{ height: 220, background: '#18191f', borderTop: '1px solid #2a2b30', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 16px', fontSize: 13, fontWeight: 'bold', color: '#adb5bd', borderBottom: '1px solid #24252a', display: 'flex', justifyContent: 'space-between' }}>
          <span>專案時間軸序列 (拖曳/排序/微調)</span>
        </div>

        <div style={{ flex: 1, display: 'flex', gap: 8, padding: '12px 16px', overflowX: 'auto', alignItems: 'center' }}>
          {project.items.map((item, idx) => {
            const isSelected = item.id === selectedId
            const isActive = idx === activeItemIndex
            const itemLen = item.end - item.start

            return (
              <div
                key={item.id}
                onClick={() => {
                  setSelectedId(item.id)
                  setActiveItemIndex(idx)
                }}
                style={{
                  minWidth: 160,
                  maxWidth: 220,
                  background: isActive ? '#1c283d' : '#25262c',
                  border: isSelected ? '2px solid #339af0' : isActive ? '2px solid #1971c2' : '1px solid #3b3d45',
                  borderRadius: 6,
                  padding: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  cursor: 'pointer',
                  position: 'relative'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 'bold', color: '#e9ecef' }}>#{idx + 1}</span>
                  <span style={{ fontSize: 11, color: '#868e96' }}>{formatTime(itemLen)}</span>
                </div>

                <div style={{ fontSize: 11, color: '#ced4da', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.source.split(/[\\/]/).pop()}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#adb5bd' }}>
                  <span>{formatTime(item.start)}</span>
                  <span>~</span>
                  <span>{formatTime(item.end)}</span>
                </div>

                {/* Trimming controls */}
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      applyProjectUpdate(trimItem(project, item.id, 'start', item.start + 0.5))
                    }}
                    style={{ flex: 1, background: '#343a40', color: '#adb5bd', border: 'none', borderRadius: 2, fontSize: 10, padding: 2, cursor: 'pointer' }}
                    title="起點 +0.5s"
                  >
                    +S
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      applyProjectUpdate(trimItem(project, item.id, 'start', item.start - 0.5))
                    }}
                    style={{ flex: 1, background: '#343a40', color: '#adb5bd', border: 'none', borderRadius: 2, fontSize: 10, padding: 2, cursor: 'pointer' }}
                    title="起點 -0.5s"
                  >
                    -S
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      applyProjectUpdate(trimItem(project, item.id, 'end', item.end - 0.5))
                    }}
                    style={{ flex: 1, background: '#343a40', color: '#adb5bd', border: 'none', borderRadius: 2, fontSize: 10, padding: 2, cursor: 'pointer' }}
                    title="終點 -0.5s"
                  >
                    -E
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      applyProjectUpdate(trimItem(project, item.id, 'end', item.end + 0.5))
                    }}
                    style={{ flex: 1, background: '#343a40', color: '#adb5bd', border: 'none', borderRadius: 2, fontSize: 10, padding: 2, cursor: 'pointer' }}
                    title="終點 +0.5s"
                  >
                    +E
                  </button>
                </div>

                {/* Move & Actions */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleMove(item.id, -1)
                      }}
                      disabled={idx === 0}
                      style={{ background: '#2c2d35', color: '#adb5bd', border: 'none', borderRadius: 2, fontSize: 10, padding: '2px 4px', cursor: 'pointer' }}
                    >
                      ◀
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleMove(item.id, 1)
                      }}
                      disabled={idx === project.items.length - 1}
                      style={{ background: '#2c2d35', color: '#adb5bd', border: 'none', borderRadius: 2, fontSize: 10, padding: '2px 4px', cursor: 'pointer' }}
                    >
                      ▶
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDuplicate(item.id)
                      }}
                      style={{ background: '#2c2d35', color: '#adb5bd', border: 'none', borderRadius: 2, fontSize: 10, padding: '2px 6px', cursor: 'pointer' }}
                      title="複製片段"
                    >
                      複製
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(item.id)
                      }}
                      style={{ background: '#fa5252', color: '#fff', border: 'none', borderRadius: 2, fontSize: 10, padding: '2px 6px', cursor: 'pointer' }}
                      title="刪除片段"
                    >
                      刪除
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {showExportModal && (
        <ExportDialog project={project} onClose={() => setShowExportModal(false)} />
      )}
    </div>
  )
}
