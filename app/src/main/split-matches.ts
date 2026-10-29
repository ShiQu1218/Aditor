import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Round } from '../shared/types'

export interface MatchRange {
  start: number
  end: number
}

export type SplitResult =
  | { ok: true; files: string[] }
  | { ok: false; reason: 'none' | 'single' | 'exists' | 'failed' | 'cancelled' }

/** Runs a command and resolves with its stdout; rejects on a non-zero exit or abort. */
export type RunCommand = (command: string, args: string[], signal: AbortSignal) => Promise<string>

/** Where the match ranges come from (Apex: engine scene tracker; VALORANT: analyzed rounds). */
export type DetectMatches = (run: RunCommand, signal: AbortSignal) => Promise<MatchRange[]>

export interface SplitDeps {
  detect: DetectMatches
  ffmpegPath: string
  /** Extra environment for spawned tools (the packaged engine needs `ADITOR_FFMPEG`). */
  env?: Record<string, string>
  run?: RunCommand
}

/** Seconds kept after a VALORANT match's last round or event so the result screen stays in the part. */
export const VALORANT_TAIL_SEC = 30

const ENGINE_OUTPUT_BYTES = 16 * 1024 * 1024

const defaultRun = (env?: Record<string, string>): RunCommand => (command, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { env: { ...process.env, ...env }, windowsHide: true, maxBuffer: ENGINE_OUTPUT_BYTES, signal },
      (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout))
  })

/** Validate the engine's `aditor matches` JSON; drop ranges that cannot be cut. */
export function parseMatches(stdout: string): MatchRange[] {
  const doc = JSON.parse(stdout) as { matches?: unknown }
  if (!Array.isArray(doc.matches)) throw new Error('Engine output has no matches array')
  return doc.matches.filter((m): m is MatchRange =>
    !!m && Number.isFinite(m.start) && Number.isFinite(m.end) && m.start >= 0 && m.end > m.start)
}

/** Apex: run the engine's `aditor matches` scene tracker on the video. */
export function engineMatches(video: string, engineCommand: string, sceneDir: string): DetectMatches {
  return async (run, signal) => parseMatches(await run(engineCommand, ['matches', video, '--scene-dir', sceneDir], signal))
}

/** Shortest time from a match's last round to the next match's first round (agent select alone takes 85 s). */
export const VALORANT_MATCH_GAP_SEC = 100

/** Standard win condition: 13 rounds with a two-round lead (overtime included). */
const decided = (r: Round): boolean => Math.max(r.ally, r.enemy) >= 13 && Math.abs(r.ally - r.enemy) >= 2

/**
 * VALORANT: group the analysis cache's rounds into matches. The round tracker restarts the score whenever the score HUD
 * has been gone for a minute, so a total that stops increasing marks a reset. A reset opens a new match only after a
 * decided match or a gap long enough for agent select and loading; a shorter reset (alt-tab, menu) stays in the match.
 * Rounds list only finished rounds, so a match ends at its last round or its last kill/death, whichever is later
 * (an abandoned match keeps its unfinished last round).
 */
export function roundMatches(rounds: unknown, events: unknown, duration: number): MatchRange[] {
  if (!Array.isArray(rounds)) return []
  const videoEnd = Number.isFinite(duration) && duration > 0 ? duration : Infinity
  const valid = rounds
    .filter((r): r is Round => !!r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 &&
      r.end >= r.start && r.start < videoEnd && Number.isInteger(r.ally) && Number.isInteger(r.enemy) &&
      r.ally >= 0 && r.enemy >= 0)
    .sort((a, b) => a.start - b.start)
  const groups: Round[][] = []
  for (const round of valid) {
    const group = groups[groups.length - 1]
    const prev = group?.[group.length - 1]
    const reset = !prev || round.ally + round.enemy <= prev.ally + prev.enemy
    if (reset && (!prev || decided(prev) || round.start - prev.end >= VALORANT_MATCH_GAP_SEC)) groups.push([round])
    else group.push(round)
  }
  const times = (Array.isArray(events) ? events : [])
    .filter((e): e is { t: number } => !!e && !e.deleted && Number.isFinite(e.t))
    .map((e) => e.t)
  return groups
    .map((group, index) => {
      const next = Math.min(groups[index + 1]?.[0].start ?? videoEnd, videoEnd)
      const last = Math.max(group[group.length - 1].end, ...times.filter((t) => t >= group[0].start && t < next))
      return { start: group[0].start, end: Math.min(last + VALORANT_TAIL_SEC, next) }
    })
    .filter((match) => match.end > match.start)
}

/** `D:/v/game.mp4` → `D:/v/game_match01.mp4` (same container, so stream copy keeps every codec). */
export function matchOutputPath(video: string, index: number): string {
  const ext = path.extname(video)
  return path.join(path.dirname(video), `${path.basename(video, ext)}_match${String(index + 1).padStart(2, '0')}${ext}`)
}

/** `game_match01.mp4` → `game_match01.partial.mp4`; watched folders skip `.partial.*` files. */
export function partialPath(output: string): string {
  const ext = path.extname(output)
  return `${output.slice(0, -ext.length)}.partial${ext}`
}

// shortcut: stream copy starts at the keyframe before `start` (a few seconds early at most); re-encode if exact cuts are needed.
export function cutArgs(video: string, match: MatchRange, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(match.start), '-i', video,
    '-t', String(match.end - match.start), '-map', '0:v', '-map', '0:a?', '-c', 'copy',
    '-avoid_negative_ts', 'make_zero', output]
}

/** Remove files this run owns; a file that cannot be removed is logged, never ignored silently. */
async function removeOwned(files: string[]): Promise<void> {
  await Promise.all(files.map((file) => fs.promises.unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') console.error('[split-matches] Could not remove', file, error)
  })))
}

/**
 * Detect the matches in `video` and stream-copy each one to its own file next to the source (the source is kept).
 * Every match is cut to a `_matchNN.partial` file first and renamed only after all cuts succeed, so a failure or crash
 * never leaves a half-written `_matchNN` file. Cleanup removes only those `.partial` names (a stale one from an
 * interrupted run is overwritten) and the outputs this run renamed; existing `_matchNN` files are never touched.
 */
export async function splitMatches(video: string, deps: SplitDeps, signal: AbortSignal): Promise<SplitResult> {
  const run = deps.run ?? defaultRun(deps.env)
  const parts: string[] = []
  const renamed: string[] = []
  try {
    const matches = await deps.detect(run, signal)
    if (matches.length === 0) return { ok: false, reason: 'none' }
    if (matches.length === 1) return { ok: false, reason: 'single' }
    const outputs = matches.map((_, index) => matchOutputPath(video, index))
    if (outputs.some((output) => fs.existsSync(output))) return { ok: false, reason: 'exists' }
    for (const [index, match] of matches.entries()) {
      parts.push(partialPath(outputs[index]))
      await run(deps.ffmpegPath, cutArgs(video, match, parts[index]), signal)
    }
    if (signal.aborted) throw new Error('Split cancelled before renaming')
    for (const [index, output] of outputs.entries()) {
      // shortcut: check-then-rename leaves a tiny window where a file appearing at `output` is replaced; fine for a user-triggered split.
      if (fs.existsSync(output)) {
        await removeOwned([...parts, ...renamed])
        return { ok: false, reason: 'exists' }
      }
      await fs.promises.rename(parts[index], output)
      renamed.push(output)
    }
    return { ok: true, files: outputs }
  } catch (error) {
    await removeOwned([...parts, ...renamed])
    if (signal.aborted) return { ok: false, reason: 'cancelled' }
    console.error('[split-matches] Failed to split matches:', error)
    return { ok: false, reason: 'failed' }
  }
}
