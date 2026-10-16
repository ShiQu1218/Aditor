// jsdom 元件測試輔助：掛載（react-dom/client + act）、鍵盤事件、缺少的瀏覽器 API 墊片。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** jsdom 沒有版面：給卷動容器一個固定尺寸，並補上 ResizeObserver／matchMedia／canvas 等。 */
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
  // canvas 2D：無實際繪圖，所有方法都是 no-op（measureText 回固定寬度）
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

/** 卸載所有已掛載的元件（afterEach 呼叫）。 */
export function cleanupMounted(): void {
  while (mounted.length) {
    const m = mounted.pop()!
    try {
      m.unmount()
    } catch {
      /* 已卸載 */
    }
  }
  document.body.innerHTML = ''
}

/** 等 Promise／計時器：在 act 內推進，讓非同步 effect 的 setState 落地。 */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

/** 在元素上送出 keydown（冒泡、可取消），包在 act 內；回傳事件以檢查 defaultPrevented。 */
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

/** 以 aria-label 找元素。 */
export function byLabel(root: ParentNode, label: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}

export function buttonByText(root: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim().includes(text)) ?? null
  )
}

/** 在 act 內聚焦（焦點事件會觸發 React 狀態更新）。 */
export function focusEl(el: HTMLElement): void {
  act(() => {
    el.focus()
  })
}
