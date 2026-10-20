/** Development only (dynamically imported by StudioScreen under import.meta.env.DEV): fake IPC for ?drawer=settings|running|done|failed|consent screenshots. */
export type DrawerFixture = 'settings' | 'running' | 'done' | 'failed' | 'consent'

export function installExportFixtureApi(kind: DrawerFixture): void {
  const GB = 1024 ** 3
  const w = window as unknown as { api?: Record<string, unknown> }
  const progress = new Set<(d: unknown) => void>()
  const fakeExport = {
    detectEncoders: async () => (kind === 'consent' ? [] : ['h264_nvenc']),
    openh264Status: async () => ({ installed: false }),
    downloadOpenH264: () => new Promise<string>(() => undefined),
    selectOutDir: async () => 'D:/Videos/Apex',
    openFolder: async () => true,
    checkOutDir: async () => ({ ok: true }),
    diskSpace: async () => ({ freeBytes: 212 * GB, totalBytes: 500 * GB }),
    start: () =>
      new Promise((resolve) => {
        const emit = (d: unknown): void => progress.forEach((cb) => cb(d))
        if (kind === 'running') {
          setTimeout(() => emit({ jobIndex: 1, totalJobs: 3, percent: 47, outTimeSeconds: 12.4 }), 30)
        } else if (kind === 'done') {
          setTimeout(() => resolve({ ok: true, outputs: ['D:/Videos/Apex/示範專案.mp4'], notices: ['影片規格不相容（解析度不同），已自動切換為精準轉碼模式'] }), 30)
        } else if (kind === 'failed') {
          setTimeout(
            () =>
              resolve({
                ok: false,
                error: '匯出失敗 (exit code 1):\n[libopenh264 @ 0000020a] Incorrect library version loaded\nError initializing output stream 0:0 --\nConversion failed!',
                outputs: []
              }),
            30
          )
        }
      }),
    cancel: async () => ({ cancelled: true }),
    onProgress: (cb: (d: unknown) => void) => {
      progress.add(cb)
      return () => progress.delete(cb)
    },
    onOpenH264Progress: () => () => undefined
  }
  w.api = {
    ...(w.api ?? {}),
    settings: { get: async () => ({ defaultOutDir: 'D:/Videos/Apex' }), ...((w.api?.settings as object) ?? {}) },
    probe: async (p: string) => (p.includes('other-match') ? { codec: 'h264', width: 1728, height: 1080 } : { codec: 'h264', width: 1920, height: 1080 }),
    export: fakeExport
  }
}
