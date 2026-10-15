import React, { useState, useEffect } from 'react'
import { Project } from '../editor/project'

interface ExportDialogProps {
  project: Project
  onClose: () => void
}

export const ExportDialog: React.FC<ExportDialogProps> = ({ project, onClose }) => {
  const [mode, setMode] = useState<'concat' | 'separate'>('concat')
  const [quality, setQuality] = useState<'copy' | 'precise'>('copy')
  const [outDir, setOutDir] = useState<string>('')
  const [baseName, setBaseName] = useState<string>(project.name || 'highlight')
  const [encoders, setEncoders] = useState<string[]>([])
  const [selectedEncoder, setSelectedEncoder] = useState<string>('')
  const [openh264Installed, setOpenh264Installed] = useState<boolean>(false)
  const [isDownloadingCodec, setIsDownloadingCodec] = useState(false)

  // Progress & Execution
  const [isExporting, setIsExporting] = useState(false)
  const [progressPercent, setProgressPercent] = useState(0)
  const [progressText, setProgressText] = useState('')
  const [notices, setNotices] = useState<string[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successOutputs, setSuccessOutputs] = useState<string[] | null>(null)

  useEffect(() => {
    const init = async () => {
      if (window.api?.export) {
        try {
          const encList: string[] = await window.api.export.detectEncoders()
          setEncoders(encList || [])
          if (encList && encList.length > 0) {
            setSelectedEncoder(encList[0])
          }

          const status = await window.api.export.openh264Status()
          setOpenh264Installed(!!status?.installed)
        } catch (err) {
          console.error('Failed to init export encoders:', err)
        }
      }
    }
    init()

    if (window.api?.export?.onProgress) {
      const unsub = window.api.export.onProgress((data: any) => {
        if (data) {
          setProgressPercent(data.percent || 0)
          setProgressText(`處理片段 ${data.jobIndex + 1}/${data.totalJobs} (${(data.outTimeSeconds || 0).toFixed(1)}s)`)
        }
      })
      return unsub
    }
  }, [])

  const handleSelectDir = async () => {
    if (window.api?.export?.selectOutDir) {
      const dir = await window.api.export.selectOutDir()
      if (dir) {
        setOutDir(dir)
      }
    }
  }

  const handleDownloadOpenH264 = async () => {
    if (window.api?.export?.downloadOpenH264) {
      setIsDownloadingCodec(true)
      try {
        await window.api.export.downloadOpenH264()
        setOpenh264Installed(true)
        const encList: string[] = await window.api.export.detectEncoders()
        setEncoders(encList || [])
        if (encList.includes('libopenh264')) {
          setSelectedEncoder('libopenh264')
        }
        alert('Cisco OpenH264 下載並安裝成功！')
      } catch (err) {
        alert('下載 OpenH264 失敗: ' + (err as Error).message)
      } finally {
        setIsDownloadingCodec(false)
      }
    }
  }

  const handleStartExport = async () => {
    if (!outDir) {
      alert('請先選擇匯出目標資料夾')
      return
    }
    if (project.items.length === 0) {
      alert('專案中沒有任何片段')
      return
    }
    if (quality === 'precise' && !selectedEncoder) {
      alert('精準模式需要可用的視訊編碼器，請選擇或下載 OpenH264')
      return
    }

    setIsExporting(true)
    setErrorMsg(null)
    setNotices([])
    setProgressPercent(0)
    setProgressText('準備開始匯出...')

    try {
      const res = await window.api.export.run({
        items: project.items,
        mode,
        quality,
        encoder: quality === 'precise' ? selectedEncoder : undefined,
        outDir,
        baseName
      })

      if (res.ok) {
        setSuccessOutputs(res.outputs || [])
        if (res.notices && res.notices.length > 0) {
          setNotices(res.notices)
        }
      } else {
        setErrorMsg(res.error || '匯出過程發生錯誤')
        if (res.notices) setNotices(res.notices)
      }
    } catch (err) {
      setErrorMsg((err as Error).message)
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
    >
      <div
        style={{
          width: 540,
          background: '#25262c',
          borderRadius: 8,
          border: '1px solid #3b3d45',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          color: '#fff',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>匯出專案</h3>
          {!isExporting && (
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', color: '#909296', fontSize: 20, cursor: 'pointer' }}
            >
              ✕
            </button>
          )}
        </div>

        {successOutputs ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ color: '#51cf66', fontWeight: 'bold' }}>✓ 匯出成功！已產出 {successOutputs.length} 個檔案：</div>
            <div style={{ maxHeight: 150, overflowY: 'auto', background: '#1c1d22', padding: 10, borderRadius: 4, fontSize: 12 }}>
              {successOutputs.map((p, i) => (
                <div key={i} style={{ color: '#ced4da', wordBreak: 'break-all' }}>{p}</div>
              ))}
            </div>
            {notices.length > 0 && (
              <div style={{ color: '#ffd43b', fontSize: 12, background: '#2c2918', padding: 8, borderRadius: 4 }}>
                {notices.map((n, i) => (
                  <div key={i}>⚠️ {n}</div>
                ))}
              </div>
            )}
            <button
              onClick={onClose}
              style={{ alignSelf: 'flex-end', background: '#228be6', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 16px', cursor: 'pointer' }}
            >
              完成
            </button>
          </div>
        ) : (
          <>
            {/* Mode selection */}
            <div>
              <div style={{ fontSize: 13, color: '#adb5bd', marginBottom: 6 }}>匯出模式</div>
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="mode"
                    value="concat"
                    checked={mode === 'concat'}
                    onChange={() => setMode('concat')}
                    disabled={isExporting}
                  />
                  <span>合輯單一檔案 (Concat)</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="mode"
                    value="separate"
                    checked={mode === 'separate'}
                    onChange={() => setMode('separate')}
                    disabled={isExporting}
                  />
                  <span>每段各自獨立檔案 (Separate)</span>
                </label>
              </div>
            </div>

            {/* Quality selection */}
            <div>
              <div style={{ fontSize: 13, color: '#adb5bd', marginBottom: 6 }}>匯出品質與速度</div>
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="quality"
                    value="copy"
                    checked={quality === 'copy'}
                    onChange={() => setQuality('copy')}
                    disabled={isExporting}
                  />
                  <span>快速無損 (Stream Copy)</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="quality"
                    value="precise"
                    checked={quality === 'precise'}
                    onChange={() => setQuality('precise')}
                    disabled={isExporting}
                  />
                  <span>精準轉碼 (Precise Re-encode)</span>
                </label>
              </div>
              <div style={{ fontSize: 11, color: '#868e96', marginTop: 4 }}>
                {quality === 'copy'
                  ? '直接複製視訊音訊封包，極速且零失真。起點會自最近的關鍵影格開始（每段可能會多出約 0~2 秒）。'
                  : '對每段進行精準畫面重新編碼，精確至毫秒切點。'}
              </div>
            </div>

            {/* Encoder settings if precise */}
            {quality === 'precise' && (
              <div style={{ background: '#1e1f24', padding: 10, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, color: '#adb5bd' }}>選擇編碼器</div>
                {encoders.length > 0 ? (
                  <select
                    value={selectedEncoder}
                    onChange={(e) => setSelectedEncoder(e.target.value)}
                    disabled={isExporting}
                    style={{ background: '#2c2d35', color: '#fff', border: '1px solid #3b3d45', borderRadius: 4, padding: '4px 8px' }}
                  >
                    {encoders.map((enc) => (
                      <option key={enc} value={enc}>
                        {enc} {enc.includes('nvenc') ? '(NVIDIA GPU)' : enc.includes('qsv') ? '(Intel GPU)' : enc.includes('amf') ? '(AMD GPU)' : '(Cisco OpenH264)'}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div style={{ fontSize: 12, color: '#ff8787' }}>
                    未偵測到硬體編碼器 (NVENC / QSV / AMF)。
                    {!openh264Installed ? (
                      <div style={{ marginTop: 6 }}>
                        <p style={{ fontSize: 11, color: '#ced4da', margin: '4px 0' }}>
                          您可以下載由 Cisco 官方發布的 OpenH264 二進位檔以啟用精準轉碼。
                        </p>
                        <button
                          onClick={handleDownloadOpenH264}
                          disabled={isDownloadingCodec}
                          style={{ background: '#228be6', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
                        >
                          {isDownloadingCodec ? '下載中...' : '下載 Cisco OpenH264 編碼器'}
                        </button>
                      </div>
                    ) : (
                      <div style={{ color: '#69db7c' }}>已安裝 OpenH264</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Base name */}
            <div>
              <div style={{ fontSize: 13, color: '#adb5bd', marginBottom: 4 }}>輸出檔案名稱前綴</div>
              <input
                type="text"
                value={baseName}
                onChange={(e) => setBaseName(e.target.value)}
                disabled={isExporting}
                style={{ width: '100%', background: '#1c1d22', border: '1px solid #3b3d45', borderRadius: 4, color: '#fff', padding: '6px 10px', boxSizing: 'border-box' }}
              />
            </div>

            {/* OutDir */}
            <div>
              <div style={{ fontSize: 13, color: '#adb5bd', marginBottom: 4 }}>目標資料夾</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={outDir}
                  readOnly
                  placeholder="請選擇輸出目標資料夾..."
                  style={{ flex: 1, background: '#1c1d22', border: '1px solid #3b3d45', borderRadius: 4, color: '#fff', padding: '6px 10px' }}
                />
                <button
                  onClick={handleSelectDir}
                  disabled={isExporting}
                  style={{ background: '#3b3d45', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer' }}
                >
                  瀏覽...
                </button>
              </div>
            </div>

            {/* Progress & Errors */}
            {isExporting && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#adb5bd' }}>
                  <span>{progressText}</span>
                  <span>{progressPercent}%</span>
                </div>
                <div style={{ height: 6, background: '#1c1d22', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${progressPercent}%`, background: '#228be6', transition: 'width 0.2s' }} />
                </div>
              </div>
            )}

            {errorMsg && (
              <div style={{ color: '#fa5252', fontSize: 12, background: '#3b1c1c', padding: 8, borderRadius: 4, maxHeight: 100, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                {errorMsg}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                onClick={onClose}
                disabled={isExporting}
                style={{ background: '#343a40', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 16px', cursor: 'pointer' }}
              >
                取消
              </button>
              <button
                onClick={handleStartExport}
                disabled={isExporting || !outDir}
                style={{ background: '#228be6', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 20px', fontWeight: 'bold', cursor: 'pointer' }}
              >
                {isExporting ? '匯出中...' : '開始匯出'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
