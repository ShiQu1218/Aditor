import React, { useState } from 'react'
import { AutoClipParams } from '../../shared/types'

interface AutoClipDialogProps {
  isOpen: boolean
  onClose: () => void
  onGenerate: (params: AutoClipParams) => void
}

export function AutoClipDialog({ isOpen, onClose, onGenerate }: AutoClipDialogProps): JSX.Element | null {
  const [params, setParams] = useState<AutoClipParams>({
    gap: 20,
    n: 3,
    before: 8,
    after: 4,
    max_len: 90
  })

  if (!isOpen) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onGenerate(params)
    onClose()
  }

  return (
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
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: '#262833',
          padding: 24,
          borderRadius: 8,
          width: 360,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          border: '1px solid #363945',
          color: '#fff'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 16px', fontSize: 18 }}>AI 自動剪輯設定</h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span>最少殺敵數 (n)：</span>
            <input
              type="number"
              min={1}
              max={10}
              value={params.n}
              onChange={(e) => setParams({ ...params, n: Number(e.target.value) })}
              style={{ width: 80, padding: '4px 8px', borderRadius: 4, border: '1px solid #363945', backgroundColor: '#18191f', color: '#fff' }}
            />
          </label>

          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span>相鄰最大間隔 (gap 秒)：</span>
            <input
              type="number"
              min={5}
              max={60}
              value={params.gap}
              onChange={(e) => setParams({ ...params, gap: Number(e.target.value) })}
              style={{ width: 80, padding: '4px 8px', borderRadius: 4, border: '1px solid #363945', backgroundColor: '#18191f', color: '#fff' }}
            />
          </label>

          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span>首殺前預留 (before 秒)：</span>
            <input
              type="number"
              min={1}
              max={30}
              value={params.before}
              onChange={(e) => setParams({ ...params, before: Number(e.target.value) })}
              style={{ width: 80, padding: '4px 8px', borderRadius: 4, border: '1px solid #363945', backgroundColor: '#18191f', color: '#fff' }}
            />
          </label>

          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span>末殺後預留 (after 秒)：</span>
            <input
              type="number"
              min={1}
              max={30}
              value={params.after}
              onChange={(e) => setParams({ ...params, after: Number(e.target.value) })}
              style={{ width: 80, padding: '4px 8px', borderRadius: 4, border: '1px solid #363945', backgroundColor: '#18191f', color: '#fff' }}
            />
          </label>

          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span>片段最長上限 (max_len 秒)：</span>
            <input
              type="number"
              min={20}
              max={300}
              value={params.max_len}
              onChange={(e) => setParams({ ...params, max_len: Number(e.target.value) })}
              style={{ width: 80, padding: '4px 8px', borderRadius: 4, border: '1px solid #363945', backgroundColor: '#18191f', color: '#fff' }}
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
            <button
              type="button"
              onClick={onClose}
              style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid #363945', backgroundColor: 'transparent', color: '#fff', cursor: 'pointer' }}
            >
              取消
            </button>
            <button
              type="submit"
              style={{ padding: '6px 14px', borderRadius: 4, border: 'none', backgroundColor: '#38bdf8', color: '#000', fontWeight: 600, cursor: 'pointer' }}
            >
              產生片段
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
