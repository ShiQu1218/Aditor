import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createToastQueue, defaultTtl, Toast, ToastQueue } from './toastQueue'

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

  useEffect(() => queue.subscribe(setToasts), [queue])

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
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="toast"
            onMouseEnter={() => queue.pause(t.id)}
            onMouseLeave={() => queue.resume(t.id)}
          >
            <span>{t.message}</span>
            {t.action && (
              <button onClick={() => { t.action!.run(); queue.dismiss(t.id) }}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
