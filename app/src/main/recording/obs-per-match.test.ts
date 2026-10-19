import { afterEach, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { ObsRecording } from './obs-session'
import { fakeObs } from './obs-test-support'
import { createRecordingService } from './index'
import { recoverSessions } from './recovery'
import { writeJson } from './finalize'
import { makeDeps, tempRoot, fakeCommand, waitFor } from './test-support'

it('逐局模式在大廳待命，開局才錄影', async () => {
  const root = tempRoot()
  const server = await fakeObs()
  const obs = new ObsRecording(root, { ...makeDeps(root).getSettings(), mode: 'match', obsPort: server.port }, undefined, vi.fn())
  try {
    await obs.start()
    expect(server.calls).not.toContain('StartRecord')
    await obs.startMatch(1)
    await obs.stop()
    await obs.startMatch(2)
    await obs.stop()
    expect(server.calls.filter((c) => c === 'StartRecord')).toHaveLength(2)
    expect(server.calls.filter((c) => c === 'StopRecord')).toHaveLength(2)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'obs-matches.json'), 'utf8')).map((m: any) => m.stopped)).toEqual([true, true])
  } finally { await obs.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function rig() {
  const root = tempRoot(); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const files = [1, 2, 3].map((n) => path.join(root, `OBS_${n}.mkv`))
  for (const file of files) fs.writeFileSync(file, '測試影片')
  const server = await fakeObs({ outputPaths: files, duration: 0 }); cleanup.push(server.close)
  const deps = makeDeps(root)
  const settings = { ...deps.getSettings(), mode: 'match' as const, backend: 'obs' as const, autoRecord: false, obsPort: server.port, postAnalysis: 'perMatch' as const }
  deps.getSettings = () => settings
  deps.recorderCommand = fakeCommand('normal')
  deps.liveEngineCommand = undefined
  deps.obsMatchPostPadMs = 100
  deps.obsFileSettleMs = 1
  deps.obsReconnectBaseMs = 60000
  deps.probeVideo = async () => ({ duration: 2 })
  deps.liveCachePath = (file) => file + '.aditor.json'
  deps.addToLibrary = vi.fn(); deps.enqueueAnalysis = vi.fn(); deps.notify = vi.fn()
  let pid: number | null = 1234
  deps.findApexPid = async () => pid
  const service = createRecordingService(deps)
  cleanup.push(() => service.stop())
  service.start(); expect(await service.startManual()).toBe(true)
  const active = (service as any).active
  const event = (ev: string, t = 0) => active.live.onMatch({ ev, t })
  return { root, files, server, deps, service, active, event, settings, exit: () => { pid = null } }
}
it('開局、後置時間停止、直接入庫並平移範圍內事件；大廳不錄影', async () => {
  const r = await rig()
  expect(r.service.status()).toMatchObject({ phase: 'recording', obsRecording: false })
  expect(r.server.calls).not.toContain('StartRecord')
  r.event('match_start')
  await waitFor(() => r.service.status().obsRecording === true)
  const offset = (r.active.obs.matches[0].recordStartedAt - r.active.obs.meta.captureStartedAt) / 1000
  r.active.live.onSnapshot({ t: 3, events: [-1, 1, 4].map((t) => ({ id: String(t), type: 'knock', t: offset + t })), spectating: [] })
  r.event('match_end', (Date.now() - r.active.obs.meta.captureStartedAt) / 1000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(r.server.calls).not.toContain('StopRecord')
  await waitFor(() => (r.deps.addToLibrary as any).mock.calls.length === 1)
  await waitFor(() => fs.existsSync(r.files[0] + '.aditor.json'))
  const cache = JSON.parse(fs.readFileSync(r.files[0] + '.aditor.json', 'utf8'))
  expect(cache.events).toHaveLength(1)
  expect(cache.events[0].t).toBeCloseTo(1)
  await waitFor(() => (r.deps.enqueueAnalysis as any).mock.calls.length === 1)
  expect(r.deps.enqueueAnalysis).toHaveBeenCalledWith(r.files[0])
  expect(r.service.status()).toMatchObject({ phase: 'recording', obsRecording: false, detectionOnly: false })
})
it.each([false, true])('直接排下一局或後置等待中開局會停止再開始：%s', async (ended) => {
  const r = await rig()
  r.event('match_start'); await waitFor(() => r.service.status().obsRecording === true)
  if (ended) r.event('match_end', (Date.now() - r.active.obs.meta.captureStartedAt) / 1000)
  r.event('match_start', 1)
  try { await waitFor(() => r.server.calls.filter((c) => c === 'StartRecord').length === 2) }
  catch (error) { throw new Error(JSON.stringify({ calls: r.server.calls, notices: (r.deps.notify as any).mock.calls, matches: r.active.obs?.matches }) + String(error)) }
  expect(r.server.calls.filter((c) => c === 'StartRecord' || c === 'StopRecord')).toEqual(['StartRecord', 'StopRecord', 'StartRecord'])
  await r.service.stopManual()
  expect(r.deps.addToLibrary).toHaveBeenCalledWith([r.files[0]])
  expect(r.deps.addToLibrary).toHaveBeenCalledWith([r.files[1]])
})
it('沒有倒數的 hud_resume 仍開始錄影，大廳回溯結束立即停止', async () => {
  const r = await rig()
  r.active.live.onMatch({ ev: 'match_start', t: 0, reason: 'hud_resume' }); await waitFor(() => r.service.status().obsRecording === true)
  r.active.obs.meta.captureStartedAt = Date.now() - 60000
  r.event('match_end', 30)
  await waitFor(() => r.server.calls.includes('StopRecord'))
  expect(r.service.status().obsRecording).toBe(false)
})
it('對局中手動結束仍停止並加入最後一局', async () => {
  const r = await rig()
  r.event('match_start'); await waitFor(() => r.service.status().obsRecording === true)
  await r.service.stopManual()
  expect(r.deps.addToLibrary).toHaveBeenCalledWith([r.files[0]])
  expect(r.server.calls.filter((c) => c === 'StopRecord')).toHaveLength(1)
})
it.each([false, true])('開局時無法連線依設定回退：%s', async (fallback) => {
  const r = await rig()
  r.settings.obsFallbackBuiltin = fallback
  r.server.disconnect()
  r.settings.obsPort = 1
  r.event('match_start')
  await waitFor(() => fallback ? r.service.status().backend === 'builtin' : r.service.status().detectionOnly === true)
  expect(r.deps.notify).toHaveBeenCalled()
})
it('停止後未入庫的逐局工作復原一次，保留原檔', async () => {
  const r = await rig()
  await r.service.stopManual()
  const dir = path.join(r.root, 'videos', '.sessions', 'recover-match')
  fs.mkdirSync(dir, { recursive: true })
  await writeJson(path.join(dir, 'recording.json'), { backend: 'obs', mode: 'match', startedAt: 1000, postAnalysis: 'afterExit' })
  await writeJson(path.join(dir, 'obs.json'), { captureStartedAt: 1000, recordStartedAt: 2000, adopted: false })
  await writeJson(path.join(dir, 'obs-matches.json'), [{ index: 1, recordStartedAt: 2000, outputPath: r.files[0], stopped: true, liveCached: false, liveTrusted: false, analysisQueued: false }])
  const failed = vi.fn()
  await recoverSessions(r.deps, vi.fn(), failed)
  await recoverSessions(r.deps, vi.fn(), failed)
  expect(failed).not.toHaveBeenCalled()
  expect(r.deps.addToLibrary).toHaveBeenCalledTimes(1)
  expect(fs.readFileSync(r.files[0], 'utf8')).toBe('測試影片')
})

it.each([false, true])('afterExit 在結束時依最終可信度排分析並更新快取：%s', async (trusted) => {
  const r = await rig()
  const configPath = path.join(r.active.dir, 'recording.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  await writeJson(configPath, { ...config, postAnalysis: 'afterExit' })
  r.event('match_start'); await waitFor(() => r.service.status().obsRecording === true)
  r.event('match_end', 0)
  await waitFor(() => fs.existsSync(r.files[0] + '.aditor.json'))
  await r.active.cuts
  expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
  const live = JSON.parse(fs.readFileSync(path.join(r.active.dir, 'live.json'), 'utf8'))
  await writeJson(path.join(r.active.dir, 'live.json'), { ...live, engine_version: '0.3.0', quality: { complete: trusted } })
  await r.service.stopManual()
  const cache = JSON.parse(fs.readFileSync(r.files[0] + '.aditor.json', 'utf8'))
  expect(cache.analysis.engine_version).toBe(trusted ? '0.3.0' : 'live-unknown')
  expect(r.deps.enqueueAnalysis).toHaveBeenCalledTimes(trusted ? 0 : 1)
})
it.each([false, true])('復原執行中的錄影，連線失敗保留工作且通知一次：%s', async (unreachable) => {
  const r = await rig()
  await r.service.stopManual()
  const dir = path.join(r.root, 'videos', '.sessions', 'recover-running')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  await writeJson(path.join(dir, 'recording.json'), { backend: 'obs', mode: 'match', startedAt: now, postAnalysis: 'none' })
  await writeJson(path.join(dir, 'obs.json'), { captureStartedAt: now, recordStartedAt: now, adopted: false })
  await writeJson(path.join(dir, 'obs-matches.json'), [{ index: 1, recordStartedAt: now, stopped: false, liveCached: false, liveTrusted: false, analysisQueued: false }])
  r.server.setRecording(true)
  // fake OBS 的目前輸出路徑由開始錄影決定。
  const client = new (await import('./obs-client')).ObsClient()
  await client.connect('127.0.0.1', r.server.port)
  await client.start(); await client.close()
  if (unreachable) r.settings.obsPort = 1
  ;(r.deps.notify as any).mockClear()
  const failed = vi.fn()
  await recoverSessions(r.deps, vi.fn(), failed)
  expect(failed).not.toHaveBeenCalled()
  expect(fs.existsSync(dir)).toBe(unreachable)
  if (unreachable) expect(r.deps.notify).toHaveBeenCalledTimes(1)
  else expect(r.deps.addToLibrary).toHaveBeenCalledWith([r.files[0]])
})

it('Apex 離開時停止並加入開放中的最後一局', async () => {
  const r = await rig()
  r.event('match_start'); await waitFor(() => r.service.status().obsRecording === true)
  r.exit()
  await waitFor(() => r.service.status().phase === 'idle')
  expect(r.deps.addToLibrary).toHaveBeenCalledWith([r.files[0]])
  expect(r.server.calls.filter((c) => c === 'StopRecord')).toHaveLength(1)
})
it('逐局模式沿用使用者錄影仍不送開始或停止指令', async () => {
  const root = tempRoot(); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const server = await fakeObs({ recording: true }); cleanup.push(server.close)
  const obs = new ObsRecording(root, { ...makeDeps(root).getSettings(), mode: 'match', obsPort: server.port }, undefined, vi.fn())
  cleanup.push(() => obs.close())
  await obs.start()
  await obs.startMatch(1)
  expect(await obs.stop()).toBe(false)
  expect(obs.perMatch).toBe(false)
  expect(server.calls).not.toContain('StartRecord')
  expect(server.calls).not.toContain('StopRecord')
  expect(fs.existsSync(path.join(root, 'obs-matches.json'))).toBe(false)
})

it('剛停止上一局時 OBS 仍回報錄影中，等它停下再開始下一局', async () => {
  const root = tempRoot()
  const server = await fakeObs()
  const obs = new ObsRecording(root, { ...makeDeps(root).getSettings(), mode: 'match', obsPort: server.port }, undefined, vi.fn())
  try {
    await obs.start()
    await obs.startMatch(1)
    await obs.stop()
    // 模擬 OBS 停止中：StopRecord 已回覆，但狀態還要一下子才變成未錄影。
    server.setRecording(true)
    setTimeout(() => server.setRecording(false), 150)
    await obs.startMatch(2)
    expect(server.calls.filter((c) => c === 'StartRecord')).toHaveLength(2)
  } finally { await obs.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

it('倒數立即錄影，HUD 確認沿用同一檔', async () => {
  const r = await rig()
  r.event('match_pending')
  await waitFor(() => r.service.status().obsRecording === true)
  const startedAt = r.active.obs.matches[0].recordStartedAt
  const offset = (startedAt - r.active.obs.meta.captureStartedAt) / 1000
  r.active.live.onSnapshot({ t: offset + 2, events: [{ id: 'pending', type: 'knock', t: offset + 1 }], spectating: [] })
  r.event('match_start')
  await r.active.obsWork
  expect(r.active.obs.matches[0]).toMatchObject({ confirmed: true, recordStartedAt: startedAt })
  await r.service.stopManual()
  expect(JSON.parse(fs.readFileSync(r.files[0] + '.aditor.json', 'utf8')).events[0].t).toBeCloseTo(1)
  expect(r.server.calls.filter((c) => c === 'StartRecord')).toHaveLength(1)
  expect(r.deps.addToLibrary).toHaveBeenCalledWith([r.files[0]])
})
it('倒數取消立即停止，保留原檔且不入庫或分析', async () => {
  const r = await rig()
  r.event('match_pending')
  await waitFor(() => r.service.status().obsRecording === true)
  r.event('match_cancel', 1)
  r.event('match_cancel', 2)
  await waitFor(() => r.server.calls.includes('StopRecord'))
  await r.active.obsWork
  const marker = JSON.parse(fs.readFileSync(path.join(r.active.dir, 'obs-matches.json'), 'utf8'))
  expect(marker[0]).toMatchObject({ confirmed: false, cancelled: true, stopped: true })
  expect((r.deps.notify as any).mock.calls.filter(([kind]: [string]) => kind === 'matchCancel')).toHaveLength(1)
  expect(r.deps.notify).toHaveBeenCalledWith('matchCancel', '倒數後未開局，已停止 OBS 錄影（檔案保留於 OBS 資料夾）')
  await r.service.stopManual()
  expect(r.deps.addToLibrary).not.toHaveBeenCalled()
  expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
  expect(fs.existsSync(r.files[0] + '.aditor.json')).toBe(false)
  expect(fs.existsSync(r.files[0])).toBe(true)
})
it('下一局倒數先停止上一檔再開始，確認不重開', async () => {
  const r = await rig()
  r.event('match_start')
  await waitFor(() => r.service.status().obsRecording === true)
  r.event('match_end', 1)
  r.event('match_pending', 1)
  await waitFor(() => r.server.calls.filter((c) => c === 'StartRecord').length === 2)
  r.event('match_start', 1)
  await r.service.stopManual()
  expect(r.server.calls.filter((c) => c === 'StartRecord' || c === 'StopRecord')).toEqual(['StartRecord', 'StopRecord', 'StartRecord', 'StopRecord'])
})
it.each([{ cancelled: true }, { confirmed: false }])('復原略過取消或未確認的已停止錄影：%j', async (state) => {
  const r = await rig()
  await r.service.stopManual()
  const dir = path.join(r.root, 'videos', '.sessions', 'recover-pending')
  fs.mkdirSync(dir, { recursive: true })
  await writeJson(path.join(dir, 'recording.json'), { backend: 'obs', mode: 'match', startedAt: 1000, postAnalysis: 'perMatch' })
  await writeJson(path.join(dir, 'obs.json'), { captureStartedAt: 1000, recordStartedAt: 2000, adopted: false })
  await writeJson(path.join(dir, 'obs-matches.json'), [{ index: 1, recordStartedAt: 2000, outputPath: r.files[0], stopped: true, ...state }])
  await recoverSessions(r.deps, vi.fn(), vi.fn())
  expect(r.deps.addToLibrary).not.toHaveBeenCalled()
  expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
  expect(fs.existsSync(r.files[0])).toBe(true)
})

it('未確認倒數在手動停止時立即取消，不等待後置時間', async () => {
  const r = await rig()
  r.deps.obsMatchPostPadMs = 60000
  r.event('match_pending')
  await waitFor(() => r.service.status().obsRecording === true)
  await r.service.stopManual()
  expect(r.deps.addToLibrary).not.toHaveBeenCalled()
  expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
})
