import { expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { once } from 'events'

const handlers = new Map<string, (...args: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn), on() {}, removeHandler() {} },
  dialog: {}, BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0' }, shell: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
import { Library } from './library'
import { AnalysisQueue } from './queue'
import { registerIpcHandlers } from './ipc-handlers'

test.skipIf(process.platform !== 'win32').each(['single', 'many'])('%s removal waits for a real Windows source lock to close', async (kind) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-delete-race-'))
  const file = path.join(dir, 'synthetic.mp4')
  fs.writeFileSync(file, 'synthetic fixture, not a user video')
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$f=[System.IO.File]::Open($env:ADITOR_AUDIT_FILE, "Open", "Read", "ReadWrite"); [Console]::WriteLine("locked"); [Console]::ReadLine() | Out-Null; Start-Sleep -Milliseconds 100; $f.Dispose()'],
    { env: { ...process.env, ADITOR_AUDIT_FILE: file }, windowsHide: true })
  const closed = once(holder, 'close')
  try {
    const [ready] = await once(holder.stdout!, 'data')
    expect(ready.toString()).toContain('locked')
    const library = new Library(path.join(dir, 'library.json'))
    library.add([file], 'recording')
    let rejectAnalysis!: (error: Error) => void
    const promise = new Promise((_resolve, reject) => { rejectAnalysis = reject })
    const engine = {
      request: () => ({ id: 'audit-analysis', promise }),
      cancel: vi.fn(() => { holder.stdin!.end('\n') })
    }
    const queue = new AnalysisQueue(engine as any, library, { profileDir: dir, cacheDir: dir })
    registerIpcHandlers(library, queue, () => [])
    queue.enqueue(file)
    const removal = kind === 'single'
      ? handlers.get('library:remove')!({}, file)
      : handlers.get('library:removeMany')!({}, [file])
    expect(engine.cancel).toHaveBeenCalledOnce()
    expect(fs.existsSync(file)).toBe(true)
    expect(library.get(file)).toBeDefined()
    await closed
    rejectAnalysis(new Error('cancelled'))
    expect(await removal).toEqual(kind === 'single' ? true : { removed: [file], failed: [] })
    expect(fs.existsSync(file)).toBe(false)
  } finally {
    holder.stdin?.end('\n')
    if (holder.exitCode === null) holder.kill()
    await closed
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
