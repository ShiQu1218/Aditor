import React, { forwardRef } from 'react'
import type { LucideProps } from 'lucide-react'

/** 32px design grid; keeps the existing icon size, colors, and ref interface. */
function createIcon(name: string, content: React.ReactNode) {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(({ size = 24, color = 'currentColor', strokeWidth = 2, absoluteStrokeWidth, className, children, ...props }, ref) => (
    <svg ref={ref} width={size} height={size} viewBox="0 0 32 32" fill="none"
      stroke={color} strokeWidth={absoluteStrokeWidth ? Number(strokeWidth) * 32 / Number(size) : strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      className={['app-icon', 'app-icon-' + name, className].filter(Boolean).join(' ')} {...props}>
      {content}{children}
    </svg>
  ))
  Icon.displayName = name
  return Icon
}

export const LayoutGrid = createIcon('layout-grid', (
  <>
    <rect x="4" y="5" width="17" height="20" rx="3" />
    <path d="M25 9h3v18a2 2 0 0 1-2 2H10" />
    <path d="m11 11 6 4-6 4Z" fill="currentColor" stroke="none" />
  </>
))
export const Film = createIcon('film', (
  <>
    <path d="M4 8h24v19H4Z M4 8l3-5h24l-3 5M13 3l-3 5M21 3l-3 5M29 3l-3 5" />
    <path d="m13 13 7 4-7 4Z" fill="currentColor" stroke="none" />
  </>
))
export const Video = createIcon('video', (
  <>
    <path d="M22 12l6-4v16l-6-4" />
    <rect x="3" y="7" width="19" height="19" rx="4" />
    <circle cx="12.5" cy="16.5" r="3.5" fill="currentColor" stroke="none" />
  </>
))
export const AnalysisQueue = createIcon('analysis-queue', (
  <>
    <path d="M5 7h16M5 14h12M5 21h9" />
    <circle cx="24" cy="23" r="6" />
    <path d="M24 20v3l2 1" />
  </>
))
export const Keyboard = createIcon('keyboard', (
  <>
    <rect x="3" y="7" width="26" height="19" rx="4" />
    <path d="M8 12h1m6 0h1m6 0h1M8 17h1m6 0h1m6 0h1M11 22h10" />
  </>
))
export const SlidersHorizontal = createIcon('sliders-horizontal', (
  <>
    <path d="M4 9h12m6 0h6M4 23h5m6 0h13" />
    <circle cx="19" cy="9" r="3" />
    <circle cx="12" cy="23" r="3" />
  </>
))
export const Sparkles = createIcon('sparkles', (
  <>
    <path d="M20 5H7a3 3 0 0 0-3 3v17a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V14" />
    <path d="m12 12 8 5-8 5Z" fill="currentColor" stroke="none" />
    <path d="m25 2 1.6 4.4L31 8l-4.4 1.6L25 14l-1.6-4.4L19 8l4.4-1.6Z" fill="currentColor" stroke="none" />
  </>
))
export const Download = createIcon('download', (
  <>
    <path d="M5 20v7h22v-7M16 22V4m-6 6 6-6 6 6" />
  </>
))
