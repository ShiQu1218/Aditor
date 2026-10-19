/**
 * 內容安全政策（I2）：只允許自家腳本；圖片／影片只從本機檔案與 data: 載入；不允許 eval、內嵌腳本、外部連線。
 * 影片另允許 blob:（錄影中觀看以 MediaSource 播放，`URL.createObjectURL(mediaSource)` 產生 blob: URL）。
 * 樣式需要 'unsafe-inline'（React 的 style 屬性）。由 vite 外掛在**正式建置**時注入 index.html
 * （開發模式的 HMR 需要內嵌腳本，不套用）。
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' file: data:",
  "media-src 'self' file: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')

export function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`
}

/** vite 外掛：build 時把 CSP meta 放進 <head>；dev server（ctx.server 存在）不注入。 */
export function cspPlugin(): {
  name: string
  transformIndexHtml: (html: string, ctx: { server?: unknown }) => string
} {
  return {
    name: 'aditor-csp',
    transformIndexHtml(html, ctx) {
      if (ctx.server) return html
      return html.replace(/<head>/i, `<head>\n    ${cspMetaTag()}`)
    }
  }
}
