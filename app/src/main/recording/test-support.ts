import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { setTimeout as delay } from 'timers/promises'
import { DEFAULT_RECORDING_SETTINGS } from '../../shared/recording'
import type { RecorderCommand, RecordingDeps } from './index'

export const fakeRecorder = path.join(__dirname, '__fixtures__', 'aditorrec.cjs')

export function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-recording-'))
}

export function fakeCommand(mode = 'normal', env: Record<string, string> = {}): RecorderCommand {
  return { command: process.execPath, args: [fakeRecorder], env: { FAKE_RECORDER_MODE: mode, ...env } }
}

export const fakeLiveEngine = path.join(__dirname, '__fixtures__', 'live-engine.cjs')

export function fakeLiveCommand(mode = 'normal', env: Record<string, string> = {}): RecorderCommand {
  return { command: process.execPath, args: [fakeLiveEngine], env: { FAKE_LIVE_MODE: mode, ...env } }
}

export function makeDeps(root: string): RecordingDeps {
  fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify({ banner_roi: [560, 700, 800, 180], spec_roi: [60, 1028, 480, 40] }))
  return {
    getSettings: () => ({ ...DEFAULT_RECORDING_SETTINGS, postAnalysis: 'none' }),
    getWatchFolders: () => [], defaultOutputDir: path.join(root, 'videos'),
    recorderCommand: fakeCommand(), ffmpegPath: 'missing-ffmpeg', profileDir: root,
    addToLibrary: () => {}, enqueueAnalysis: () => {}, notify: () => {},
    findApexPid: async () => 1234, pollMs: 20, gameStartDelayMs: 0
  }
}

export async function waitFor(condition: () => boolean, timeout = 10000): Promise<void> {
  // Use real time so tests with fake timers can still wait for actual child-process I/O.
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (condition()) return
    await delay(10)
  }
  throw new Error('Timed out waiting for test condition')
}

const exe = process.platform === 'win32' ? '.exe' : ''
export const ffmpeg = [process.env.ADITOR_FFMPEG,
  path.resolve(__dirname, '../../../../build/ffmpeg/bin', 'ffmpeg' + exe), 'ffmpeg']
  .find((bin) => bin && spawnSync(bin, ['-version'], { windowsHide: true }).status === 0)

export function createSegments(root: string): string {
  const dir = path.join(root, 'segments')
  fs.mkdirSync(dir)
  const source = path.join(root, 'source.mp4')
  const result = spawnSync(ffmpeg!, ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'mpeg4', '-g', '20', '-bf', '0', '-c:a', 'aac',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', source],
    { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || String(result.error))
  const bytes = fs.readFileSync(source)
  const starts: number[] = []
  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset)
    if (size < 8) throw new Error('Test MP4 box size is invalid')
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'moof') starts.push(offset)
    offset += size
  }
  if (starts.length < 2) throw new Error('Test source did not produce multiple fMP4 segments')
  fs.writeFileSync(path.join(dir, 'init.mp4'), bytes.subarray(0, starts[0]))
  const index = starts.map((start, i) => {
    const fragment = bytes.subarray(start, starts[i + 1] ?? bytes.length)
    fs.writeFileSync(path.join(dir, `seg_${String(i + 1).padStart(6, '0')}.m4s`), fragment)
    return { seq: i + 1, pts: i * 2, dur: 2, bytes: fragment.length, wall: new Date().toISOString() }
  })
  fs.writeFileSync(path.join(dir, 'index.jsonl'), index.map((e) => JSON.stringify(e) + '\n').join(''))
  return dir
}

export function sessionDir(root: string, name = '20261018-123456-abcd'): string {
  const dir = path.join(root, 'videos', '.sessions', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: new Date(2026, 9, 18, 12, 34).getTime(), postAnalysis: 'none' }))
  return dir
}

export function copySegments(source: string, dir: string): void {
  for (const file of fs.readdirSync(source)) fs.copyFileSync(path.join(source, file), path.join(dir, file))
}
