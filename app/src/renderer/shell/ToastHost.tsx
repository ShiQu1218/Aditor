import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createToastQueue, defaultTtl, Toast, ToastQueue } from './toastQueue'
import { attachKeymap } from '../hooks/useShortcuts'
import { shellI18n } from '../i18n'

type ToastInput = { message: string; action?: Toast['action']; ttlMs?: number }
const ToastContext = createContext<((t: ToastInput) => void) | null>(null)

/** Get the function for pushing a toast. */
export function useToast(): (t: ToastInput) => void {
  const push = useContext(ToastContext)
  if (!push) throw new Error('useToast must be used within ToastProvider')
  return push
}

export function ToastProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const queueRef = useRef<ToastQueue>()
  if (!queueRef.current) queueRef.current = createToastQueue(3)
  const queue = queueRef.current
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const hostRef = useRef<HTMLDivElement>(null)
  /** Focus target before Alt+T enters the notification; return focus here after Undo (the notification disappears, so focus must not fall to body). */
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => queue.subscribe(setToasts), [queue])

  // Alt+T (keymap's focusToast): move focus to the newest Undo button without tabbing through the entire screen.
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
            // Pause the timer on both mouse hover and keyboard focus (do not auto-dismiss while Undo has focus).
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
