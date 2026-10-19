// jsdom component-test helpers: mounting (react-dom/client + act), keyboard events, and missing browser API shims.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** jsdom has no layout: give scroll containers fixed dimensions and provide ResizeObserver, matchMedia, canvas, etc. */
export function installDomShims(size = { width: 1200, height: 700 }): void {
  const proto = HTMLElement.prototype
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => size.width })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => size.height })
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 120 })
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined
  // Canvas 2D: no drawing is performed; every method is a no-op (measureText returns a fixed width).
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'measureText') return () => ({ width: 10 })
      if (prop === 'createLinearGradient') return () => ({ addColorStop: () => undefined })
      return () => undefined
    },
    set(target, prop: string, value) {
      target[prop] = value
      return true
    }
  })
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext
  HTMLMediaElement.prototype.play = (() => Promise.resolve()) as typeof HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.pause = (() => undefined) as typeof HTMLMediaElement.prototype.pause
  HTMLMediaElement.prototype.load = (() => undefined) as typeof HTMLMediaElement.prototype.load
}

export interface Mounted {
  container: HTMLElement
  root: Root
  unmount: () => void
}

const mounted: Mounted[] = []

export function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(ui))
  const m: Mounted = {
    container,
    root,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
  mounted.push(m)
  return m
}

/** Unmount all mounted components (called from afterEach). */
export function cleanupMounted(): void {
  while (mounted.length) {
    const m = mounted.pop()!
    try {
      m.unmount()
    } catch {
      /* Already unmounted. */
    }
  }
  document.body.innerHTML = ''
}

/** Advance promises/timers inside act so state updates from asynchronous effects are applied. */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

/** Dispatch a bubbling, cancelable keydown event inside act; return it to inspect defaultPrevented. */
export function press(target: Element | Window, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

export function click(el: Element): void {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

/** Find an element by aria-label. */
export function byLabel(root: ParentNode, label: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}

export function buttonByText(root: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim().includes(text)) ?? null
  )
}

/** Focus inside act (focus events can trigger React state updates). */
export function focusEl(el: HTMLElement): void {
  act(() => {
    el.focus()
  })
}
