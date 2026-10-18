import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { LiveEngine, mergeIncarnations, parseSnapshot, type LiveSnapshot } from './live-engine'
import { fakeLiveCommand, tempRoot, waitFor } from './test-support'
import type { LiveEvent } from '../../shared/recording'

const roots: string[] = []
const engines: LiveEngine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function root(): string { const value = tempRoot(); roots.push(value); return value }
function engine(mode: string, env: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof LiveEngine>[0]> = {}): LiveEngine {
  const value = new LiveEngine({ command: fakeLiveCommand(mode, env), args: ['--shm', 'Local\\apexrec-x', '--profile-dir', 'p'],
    restartBaseMs: 10, setPriority: () => undefined, ...extra })
  engines.push(value)
  return value
}
const ev = (id: string, t: number): LiveEvent => ({ id, t, type: 'knock', score: 1, damage_line: false, name_sig: null,
  counted: true, counted_reason: 'first', counted_override: null, source: 'auto' })
const traceOf = (file: string): Record<string, unknown>[] => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

describe('live 引擎輸出解析', () => {
  it('snapshot 欄位驗證：事件需有 id／t／type，觀戰區間需有效', () => {
    expect(parseSnapshot({ t: 1, events: [ev('a1', 1)], spectating: [{ start: 0, end: 1 }] })).not.toBeNull()
    expect(parseSnapshot({ t: 1, events: [{ id: 'a1', t: -1, type: 'knock' }], spectating: [] })).toBeNull()
    expect(parseSnapshot({ t: 1, events: [{ t: 1, type: 'knock' }], spectating: [] })).toBeNull()
    expect(parseSnapshot({ t: 1, events: [], spectating: [{ start: 2, end: 1 }] })).toBeNull()
    expect(parseSnapshot({ t: 'x', events: [], spectating: [] })).toBeNull()
    expect(parseSnapshot({ t: 1, events: 'x', spectating: [] })).toBeNull()
  })

  it('最終 snapshot 帶判定；重啟過的合併結果一律不完整', () => {
    const final = parseSnapshot({ t: 1, events: [], spectating: [], final: true, quality: { complete: true, reasons: [], h_scale: 1.05 } })
    expect(final?.quality).toEqual({ complete: true, reasons: [], hScale: 1.05 })
    expect(parseSnapshot({ t: 1, events: [], spectating: [], quality: { complete: true } })?.quality).toBeUndefined()
    const merged = mergeIncarnations({ t: 1, events: [], spectating: [] }, final!, 1)
    expect(merged.quality).toEqual({ complete: false, reasons: ['restarted'], hScale: 1.05 })
  })

  it('重啟後合併：封存全部保留，新程序只取封存時間之後且不重複的事件', () => {
    const archived: LiveSnapshot = { t: 10, events: [ev('a1000', 1), ev('a9000', 9)], spectating: [{ start: 2, end: 3 }] }
    const fresh: LiveSnapshot = { t: 20, events: [ev('a5000', 5), ev('a9000', 9), ev('a15000', 15)], spectating: [{ start: 4, end: 5 }, { start: 12, end: 13 }] }
    const merged = mergeIncarnations(archived, fresh, 10)
    expect(merged.events.map((e) => e.id)).toEqual(['a1000', 'a9000', 'a15000'])
    expect(merged.spectating).toEqual([{ start: 2, end: 3 }, { start: 12, end: 13 }])
    expect(merged.t).toBe(20)
    expect(mergeIncarnations(null, fresh, -1)).toBe(fresh)
  })
})

describe('LiveEngine 程序管理', () => {
  it('傳遞參數、降低優先序、轉送事件；停止時送 stop 並等最終 snapshot', async () => {
    const dir = root()
    const trace = path.join(dir, 'trace.jsonl')
    const setPriority = vi.fn()
    const value = engine('normal', { FAKE_LIVE_TRACE: trace }, { setPriority })
    const matches = vi.fn()
    value.on('match', matches)
    value.start()
    await waitFor(() => value.snapshot() !== null)
    expect(value.engineVersion()).toBe('0.3.0')
    expect(setPriority).toHaveBeenCalledWith(expect.any(Number))
    expect(matches).toHaveBeenCalledWith({ ev: 'match_start', t: 0.5, reason: 'countdown' })
    expect(value.snapshot()!.events.map((e) => e.id)).toEqual(['a1000'])
    await value.stop()
    expect(value.snapshot()!.events.map((e) => e.id)).toEqual(['a1000', 'a3500'])
    expect(matches).toHaveBeenLastCalledWith({ ev: 'match_end', t: 3.5, reason: 'lobby' })
    const lines = traceOf(trace)
    expect(lines[0]).toEqual({ argv: ['--shm', 'Local\\apexrec-x', '--profile-dir', 'p'] })
    expect(lines).toContainEqual({ stdin: '{"cmd":"stop"}' })
  })

  it('當掉後以退避重啟，並保留重啟前的事件', async () => {
    const dir = root()
    const trace = path.join(dir, 'trace.jsonl')
    const value = engine('crash-once', { FAKE_LIVE_TRACE: trace, FAKE_LIVE_STATE: path.join(dir, 'state') })
    const restarting = vi.fn()
    value.on('restarting', restarting)
    value.start()
    await waitFor(() => restarting.mock.calls.length === 1 && (value.snapshot()?.events.length ?? 0) >= 2)
    expect(restarting.mock.calls[0][0].delayMs).toBe(10)
    // 新程序在 t=0.5 的事件早於封存時間（最後一次看到 t=2），丟棄；a3000 保留。
    expect(value.snapshot()!.events.map((e) => e.id)).toEqual(['a1000', 'a3000'])
    expect(value.snapshot()!.spectating).toEqual([{ start: 0.2, end: 0.4 }])
    await value.stop()
    expect(value.snapshot()!.events.map((e) => e.id)).toEqual(['a1000', 'a3000', 'a3500'])
    expect(value.snapshot()!.spectating).toEqual([{ start: 0.2, end: 0.4 }, { start: 3.6, end: 3.9 }])
    expect(traceOf(trace).filter((line) => line.argv)).toHaveLength(2)
  })

  it('10 分鐘內重啟 5 次後放棄並回報，不再啟動', async () => {
    const value = new LiveEngine({ command: { command: process.execPath, args: ['-e', 'process.exit(2)'] }, args: [], restartBaseMs: 1, setPriority: () => undefined })
    engines.push(value)
    const failed = vi.fn()
    const restarting = vi.fn()
    value.on('failed', failed)
    value.on('restarting', restarting)
    value.start()
    await waitFor(() => failed.mock.calls.length === 1)
    expect(restarting).toHaveBeenCalledTimes(5)
    expect(restarting.mock.calls.map(([info]) => info.delayMs)).toEqual([1, 2, 4, 8, 16])
    expect(String(failed.mock.calls[0][0].message)).toContain('錄影不受影響')
  })

  it('格式錯誤的行只略過；停止逾時就強制結束', async () => {
    const garbage = engine('garbage')
    const warning = vi.fn()
    garbage.on('warning', warning)
    garbage.start()
    await waitFor(() => garbage.snapshot() !== null)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('JSON'))
    const stuck = engine('never-stop', {}, { stopTimeoutMs: 100 })
    stuck.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = performance.now()
    await stuck.stop()
    expect(performance.now() - started).toBeLessThan(3000)
  })
})
