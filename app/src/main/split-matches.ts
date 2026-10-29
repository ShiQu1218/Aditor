import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface MatchRange {
  start: number
  end: number
}

export type SplitResult =
  | { ok: true; files: string[] }
  | { ok: false; reason: 'none' | 'single' | 'exists' | 'failed' | 'cancelled' }

/** Runs a command and resolves with its stdout; rejects on a non-zero exit or abort. */
export type RunCommand = (command: string, args: string[], signal: AbortSignal) => Promise<string>

export interface SplitDeps {
  /** Engine executable and environment (the `matches` subcommand is appended here). */
  engine: { command: string; env?: Record<string, string> }
  sceneDir: string
  ffmpegPath: string
  run?: RunCommand
}

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
 * Detect Apex matches in `video` and stream-copy each one to its own file next to the source (the source is kept).
 * Every match is cut to a `_matchNN.partial` file first and renamed only after all cuts succeed, so a failure or crash
 * never leaves a half-written `_matchNN` file. Cleanup removes only those `.partial` names (a stale one from an
 * interrupted run is overwritten) and the outputs this run renamed; existing `_matchNN` files are never touched.
 */
export async function splitMatches(video: string, deps: SplitDeps, signal: AbortSignal): Promise<SplitResult> {
  const run = deps.run ?? defaultRun(deps.engine.env)
  const parts: string[] = []
  const renamed: string[] = []
  try {
    const stdout = await run(deps.engine.command, ['matches', video, '--scene-dir', deps.sceneDir], signal)
    const matches = parseMatches(stdout)
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
