import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import { registerExportHandlers, createExportService } from './export-ipc'

/** 預載腳本 ↔ main 處理器 ↔ renderer 使用的頻道必須一致（不靠人眼對照）。 */
const root = path.resolve(__dirname, '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8')

const preload = read('preload/index.ts')
const ipcHandlers = read('main/ipc-handlers.ts')
const exportIpc = read('main/export/export-ipc.ts')

function exportBlock(src: string): string {
  const i = src.indexOf('export: {')
  return src.slice(i)
}

describe('export IPC wiring', () => {
  const block = exportBlock(preload)
  const invoked = [...block.matchAll(/invoke\('(export:[A-Za-z0-9]+)'/g)].map((m) => m[1])
  const listened = [...block.matchAll(/\.on\('(export:[A-Za-z0-9]+)'/g)].map((m) => m[1])

  test('every channel the preload invokes has a main handler', () => {
    const registered: string[] = []
    registerExportHandlers({ handle: (ch) => registered.push(ch) }, createExportService())
    for (const m of ipcHandlers.matchAll(/ipcMain\.handle\('(export:[A-Za-z0-9]+)'/g)) registered.push(m[1])
    expect(invoked.length).toBe(9)
    for (const ch of invoked) expect(registered, ch).toContain(ch)
  })

  test('every channel the preload listens on is sent by main', () => {
    expect(listened.sort()).toEqual(['export:openh264Progress', 'export:progress'])
    expect(exportIpc).toContain("send('export:progress'")
    expect(ipcHandlers).toContain("send('export:openh264Progress'")
  })

  test('preload unsubscribes every listener it adds', () => {
    for (const ch of listened) expect(block).toContain(`removeListener('${ch}'`)
  })

  test('the old export:run alias is gone everywhere', () => {
    expect(invoked).not.toContain('export:run')
    expect(preload).not.toMatch(/export:run|\brun:\s*\(opts/)
    expect(ipcHandlers).not.toContain('export:run')
    expect(exportIpc).not.toContain('export:run')
    const rendererFiles = fs
      .readdirSync(path.join(root, 'renderer'), { recursive: true, encoding: 'utf-8' })
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
    for (const f of rendererFiles) {
      const src = fs.readFileSync(path.join(root, 'renderer', f), 'utf-8')
      expect(src, f).not.toMatch(/export\.run\(|alert\(/)
    }
  })

  test('the renderer ExportApi method set equals the preload export object', () => {
    const preloadKeys = [...block.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]).sort()
    const ctrl = read('renderer/studio/exportController.ts')
    const iface = ctrl.slice(ctrl.indexOf('export interface ExportApi'), ctrl.indexOf('type StartResult'))
    const apiKeys = [...iface.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]).sort()
    expect(apiKeys).toEqual(preloadKeys)
  })
})
