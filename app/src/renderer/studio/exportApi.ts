import type { ExportApi } from './exportController'

/** 延遲綁定 `window.api.export`（preload 暴露）；沒有 IPC（純瀏覽器預覽）時回傳明確的錯誤而不是丟 TypeError。 */
function api(): Record<string, (...a: unknown[]) => unknown> {
  const a = (window as unknown as { api?: { export?: Record<string, (...a: unknown[]) => unknown> } }).api?.export
  if (!a) throw new Error('匯出功能需要在 App 視窗內執行')
  return a
}

export const windowExportApi: ExportApi = {
  detectEncoders: async () => (await api().detectEncoders()) as string[],
  openh264Status: async () => (await api().openh264Status()) as { installed: boolean },
  downloadOpenH264: async () => (await api().downloadOpenH264()) as string,
  selectOutDir: async () => (await api().selectOutDir()) as string | null,
  openFolder: async (dir) => (await api().openFolder(dir)) as boolean,
  start: async (opts) => (await api().start(opts)) as never,
  cancel: async () => (await api().cancel()) as { cancelled: boolean },
  checkOutDir: async (dir) => (await api().checkOutDir(dir)) as { ok: true } | { ok: false; reason: string },
  diskSpace: async (dir) => (await api().diskSpace(dir)) as { freeBytes: number; totalBytes: number },
  onProgress: (cb) => {
    try {
      return api().onProgress(cb) as () => void
    } catch {
      return () => undefined
    }
  },
  onOpenH264Progress: (cb) => {
    try {
      return api().onOpenH264Progress(cb) as () => void
    } catch {
      return () => undefined
    }
  }
}
