import React from 'react'

/** 佇列環形進度：conic-gradient 以 `--p`（0–100）變數呈現，2 Hz 更新成本極低。 */
export function QueueRing({ progress }: { progress: number }): JSX.Element {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100)
  return <span className="ring" style={{ ['--p' as string]: pct } as React.CSSProperties} aria-hidden="true" />
}
