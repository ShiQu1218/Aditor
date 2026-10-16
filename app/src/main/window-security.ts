/**
 * 視窗安全（I2）：App 是單頁應用，不會導航到別的網址、也不開新視窗。
 * 拖入檔案時 Chromium 預設會導航到 file:///...，把整個 SPA 換掉並拿到完整的 preload API，所以一律阻擋。
 */
export interface SecureWebContents {
  on(event: 'will-navigate' | 'will-redirect' | 'will-attach-webview', listener: (e: { preventDefault(): void }, url?: string) => void): unknown
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  getURL(): string
}

const stripHash = (u: string): string => u.replace(/#.*$/, '')

export function applyWindowSecurity(wc: SecureWebContents): void {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e, url) => {
    // 開發模式的整頁重新整理（同一網址）放行；其餘一律阻擋
    if (url && stripHash(url) === stripHash(wc.getURL())) return
    e.preventDefault()
  })
  wc.on('will-redirect', (e) => e.preventDefault())
  wc.on('will-attach-webview', (e) => e.preventDefault())
}
