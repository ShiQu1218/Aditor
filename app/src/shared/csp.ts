/**
 * Content Security Policy (I2): allow only our own scripts; load images/video only from local files and data:; disallow eval, inline scripts, and external connections.
 * Also allow blob: for video (live viewing uses MediaSource, and `URL.createObjectURL(mediaSource)` returns a blob: URL).
 * Styles require 'unsafe-inline' (React style attributes). A Vite plugin injects the policy into index.html in **production builds**
 * (not in development, where HMR requires inline scripts).
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

/** Vite plugin: add the CSP meta tag to <head> during build; do not inject it on the dev server (ctx.server is present). */
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
