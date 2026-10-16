import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createToastQueue, defaultTtl, Toast, ToastQueue } from './toastQueue'
import { attachKeymap } from '../hooks/useShortcuts'
import { shellI18n } from '../i18n/zh-TW'

type ToastInput = { message: string; action?: Toast['action']; ttlMs?: number }
const ToastContext = createContext<((t: ToastInput) => void) | null>(null)

/** 取得推送 toast 的函式 */
export function useToast(): (t: ToastInput) => void {
  const push = useContext(ToastContext)
  if (!push) throw new Error('useToast 必須在 ToastProvider 內使用')
  return push
}

export function ToastProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const queueRef = useRef<ToastQueue>()
  if (!queueRef.current) queueRef.current = createToastQueue(3)
  const queue = queueRef.current
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const hostRef = useRef<HTMLDivElement>(null)
  /** Alt+T 跳進通知前的焦點：按了〔復原〕後還給它（通知會消失，焦點不該掉到 body） */
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => queue.subscribe(setToasts), [queue])

  // Alt+T（keymap 的 focusToast）：把焦點移到最新的〔復原〕按鈕，不必 Tab 穿過整個畫面
  useEffect(
    () =>
      attachKeymap(window, () => ({
        handlers: {
          focusToast: () => {
            const buttons = hostRef.current?.querySelectorAll<HTMLElement>('.toast button')
            const target = buttons && buttons.length > 0 ? buttons[buttons.length - 1] : null
            if (!target) return
            const cur = document.activeElement as HTMLElement | null
            if (cur && !hostRef.current?.contains(cur)) returnFocus.current = cur
            target.focus()
          }
        },
        screen: 'library',
        mode: 'source',
        overlayOpen: false
      })),
    []
  )

  const push = useMemo(() => (t: ToastInput) => {
    queue.push({
      id: `toast_${Date.now()}_${seq.current++}`,
      message: t.message,
      action: t.action,
      ttlMs: t.ttlMs ?? defaultTtl(!!t.action)
    })
  }, [queue])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div ref={hostRef} className="toast-host" role="status" aria-live="polite" aria-label={shellI18n.toastHost.label}>
        {toasts.map((t) => (
          <div
            key={t.id}
            className="toast"
            // 滑鼠停留與鍵盤焦點都暫停計時（焦點在〔復原〕上時不會自動消失）
            onMouseEnter={() => queue.pause(t.id)}
            onMouseLeave={() => queue.resume(t.id)}
            onFocus={() => queue.pause(t.id)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) queue.resume(t.id)
            }}
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.run()
                  queue.dismiss(t.id)
                  const back = returnFocus.current
                  returnFocus.current = null
                  if (back && back.isConnected) back.focus()
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
