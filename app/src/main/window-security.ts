/**
 * Window security (I2): the app is a single-page application and does not navigate to other URLs or open new windows.
 * Chromium navigates to file:///... by default when a file is dropped, replacing the SPA and exposing the full preload API, so always block it.
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
    // Allow full-page reloads at the same URL in development; block everything else.
    if (url && stripHash(url) === stripHash(wc.getURL())) return
    e.preventDefault()
  })
  wc.on('will-redirect', (e) => e.preventDefault())
  wc.on('will-attach-webview', (e) => e.preventDefault())
}
