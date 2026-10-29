import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cutArgs, matchOutputPath, parseMatches, partialPath, splitMatches, type RunCommand } from './split-matches'

let dir: string
let video: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-split-'))
  video = path.join(dir, 'stream.mp4')
  fs.writeFileSync(video, 'source')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const TWO = [{ start: 0, end: 100 }, { start: 120, end: 300 }]

/** Engine prints `engineOut`; each ffmpeg call writes its output, runs `onCut`, or fails on the `failAt`-th cut. */
function fakeRun(engineOut: string, opts: { failAt?: number; onCut?: (index: number) => void } = {}): { run: RunCommand; calls: string[][] } {
  const calls: string[][] = []
  let cuts = 0
  const run: RunCommand = async (command, args) => {
    calls.push([command, ...args])
    if (command === 'aditor') return engineOut
    const index = cuts++
    if (index === opts.failAt) throw new Error('ffmpeg failed')
    fs.writeFileSync(args.at(-1)!, 'cut')
    opts.onCut?.(index)
    return ''
  }
  return { run, calls }
}

const engineJson = (matches: unknown): string => JSON.stringify({ matches })
const deps = (run: RunCommand) => ({ engine: { command: 'aditor' }, sceneDir: 'scene', ffmpegPath: 'ffmpeg', run })
const split = (run: RunCommand, signal = new AbortController().signal) => splitMatches(video, deps(run), signal)
/** Files in the temp dir other than the source. */
const leftovers = (): string[] => fs.readdirSync(dir).filter((name) => name !== 'stream.mp4').sort()

describe('parseMatches', () => {
  it('keeps valid ranges and drops empty or malformed ones', () => {
    const out = parseMatches(JSON.stringify({ matches: [{ start: 0, end: 10 }, { start: 5, end: 5 }, null, { start: 'x', end: 1 }] }))
    expect(out).toEqual([{ start: 0, end: 10 }])
  })

  it('rejects output without a matches array', () => {
    expect(() => parseMatches('{}')).toThrow()
  })
})

describe('output names', () => {
  it('numbers outputs next to the source and keeps the container', () => {
    expect(matchOutputPath(path.join('D:', 'v', 'game.mkv'), 0)).toBe(path.join('D:', 'v', 'game_match01.mkv'))
  })

  it('marks in-progress cuts as .partial so watched folders skip them', () => {
    expect(partialPath(path.join('D:', 'v', 'game_match01.mkv'))).toBe(path.join('D:', 'v', 'game_match01.partial.mkv'))
  })
})

describe('cutArgs', () => {
  it('stream-copies the range', () => {
    const args = cutArgs('in.mp4', { start: 12.5, end: 72.5 }, 'out.mp4')
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '12.5'])
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '60'])
    expect(args).toContain('copy')
    expect(args.at(-1)).toBe('out.mp4')
  })
})

describe('splitMatches', () => {
  it('cuts each match to a partial file, then renames all of them', async () => {
    const { run, calls } = fakeRun(engineJson(TWO))
    expect(await split(run)).toEqual({ ok: true, files: [matchOutputPath(video, 0), matchOutputPath(video, 1)] })
    expect(calls[0]).toEqual(['aditor', 'matches', video, '--scene-dir', 'scene'])
    expect(calls[1].at(-1)).toBe(partialPath(matchOutputPath(video, 0)))
    expect(leftovers()).toEqual(['stream_match01.mp4', 'stream_match02.mp4'])
  })

  it('reports no matches separately from a single match', async () => {
    expect(await split(fakeRun(engineJson([])).run)).toEqual({ ok: false, reason: 'none' })
    expect(await split(fakeRun(engineJson([{ start: 0, end: 100 }])).run)).toEqual({ ok: false, reason: 'single' })
  })

  it('fails without cutting when the engine output is invalid or the engine exits with an error', async () => {
    const invalid = fakeRun('not json')
    expect(await split(invalid.run)).toEqual({ ok: false, reason: 'failed' })
    expect(invalid.calls).toHaveLength(1)
    const crashed: RunCommand = async () => { throw new Error('exit code 1') }
    expect(await split(crashed)).toEqual({ ok: false, reason: 'failed' })
    expect(leftovers()).toEqual([])
  })

  it('refuses to overwrite an existing output', async () => {
    fs.writeFileSync(matchOutputPath(video, 1), 'user file')
    expect(await split(fakeRun(engineJson(TWO)).run)).toEqual({ ok: false, reason: 'exists' })
    expect(fs.readFileSync(matchOutputPath(video, 1), 'utf8')).toBe('user file')
  })

  it('keeps a file that appears during the cut and removes only its own partial files', async () => {
    const late = matchOutputPath(video, 1)
    const { run } = fakeRun(engineJson(TWO), { onCut: (index) => { if (index === 0) fs.writeFileSync(late, 'user file') } })
    expect(await split(run)).toEqual({ ok: false, reason: 'exists' })
    expect(fs.readFileSync(late, 'utf8')).toBe('user file')
    expect(leftovers()).toEqual(['stream_match02.mp4'])
  })

  it('removes its partial files when a cut fails', async () => {
    expect(await split(fakeRun(engineJson(TWO), { failAt: 1 }).run)).toEqual({ ok: false, reason: 'failed' })
    expect(leftovers()).toEqual([])
  })

  it('overwrites a stale partial file from an interrupted run and leaves the source untouched', async () => {
    fs.writeFileSync(partialPath(matchOutputPath(video, 0)), 'stale')
    expect((await split(fakeRun(engineJson(TWO)).run)).ok).toBe(true)
    expect(fs.readFileSync(matchOutputPath(video, 0), 'utf8')).toBe('cut')
    expect(fs.readFileSync(video, 'utf8')).toBe('source')
    expect(leftovers()).toEqual(['stream_match01.mp4', 'stream_match02.mp4'])
  })

  it('removes renamed outputs and partial files when a later rename fails', async () => {
    const rename = fs.promises.rename
    vi.spyOn(fs.promises, 'rename')
      .mockImplementationOnce(rename)
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    expect(await split(fakeRun(engineJson(TWO)).run)).toEqual({ ok: false, reason: 'failed' })
    expect(leftovers()).toEqual([])
  })

  it('reports cancellation after a partial cut and cleans up', async () => {
    const controller = new AbortController()
    const { run } = fakeRun(engineJson(TWO), { onCut: () => { controller.abort(); throw new Error('aborted') } })
    expect(await split(run, controller.signal)).toEqual({ ok: false, reason: 'cancelled' })
    expect(leftovers()).toEqual([])
  })
})
