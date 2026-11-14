import { execFile } from 'child_process'
import { GAMES, GAME_IDS, type GameId } from '../../shared/games'

export interface GameProcess {
  game: GameId
  pid: number
}

/** Returns the first supported game in `tasklist /FO CSV /NH` output, in listing order. */
export function parseGameProcess(output: string): GameProcess | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)"/.exec(line.trim())
    if (!match) continue
    const game = GAME_IDS.find((id) => GAMES[id].process.test(match[1]))
    const pid = Number(match[2])
    if (game && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff) return { game, pid }
  }
  return null
}

// Exit codes of a tasklist that never ran its query; one retry usually succeeds.
const TRANSIENT_EXIT_CODES = new Set<unknown>([
  // STATUS_DLL_INIT_FAILED: tasklist could not start; seen on idle or low-memory machines even with one query at a time.
  0xC0000142,
  // DBG_TERMINATE_PROCESS: tasklist was terminated from outside, likely by session end or security software; seen in v0.4.6.
  0x40010004
])
const TRANSIENT_RETRY_MS = 500

async function queryGame(game: GameId): Promise<GameProcess | null> {
  try {
    return await runTasklist(game)
  } catch (error) {
    if (!TRANSIENT_EXIT_CODES.has((error as { code?: unknown }).code)) throw error
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_MS))
    return runTasklist(game)
  }
}

function runTasklist(game: GameId): Promise<GameProcess | null> {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${GAMES[game].tasklistImageFilter}`],
      { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(parseGameProcess(stdout))
      })
  })
}

/**
 * One `tasklist` at a time, in GAME_IDS priority order. Spawning one per game concurrently made
 * tasklist fail with 0xC0000142 (DLL initialization failed) on several machines since v0.4.5.
 */
export async function findGameProcess(): Promise<GameProcess | null> {
  for (const game of GAME_IDS) {
    const match = await queryGame(game)
    if (match) return match
  }
  return null
}

// Recheck image names every 10 polls (normally 30 seconds) to bound stale detection after PID reuse.
export const GAME_PROCESS_RECHECK_POLLS = 10

export function createGameProcessFinder(find = findGameProcess): () => Promise<GameProcess | null> {
  let known: GameProcess | null = null
  let polls = 0
  return async () => {
    if (known && ++polls < GAME_PROCESS_RECHECK_POLLS) {
      try {
        process.kill(known.pid, 0)
        return known
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EPERM') return known
        if (code !== 'ESRCH') throw error
      }
    }
    // Keep retrying enumeration after a failed recheck, even if the old PID is alive.
    polls = GAME_PROCESS_RECHECK_POLLS
    known = await find()
    polls = 0
    return known
  }
}

export function sameProcess(a: GameProcess | null, b: GameProcess | null): boolean {
  return a === b || (a !== null && b !== null && a.game === b.game && a.pid === b.pid)
}

/** Polls never overlap; a failed process query does not mean the game has closed. */
export class GameWatcher<T> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private generation = 0
  private candidate: T | null = null
  private count = 0

  constructor(
    private find: () => Promise<T | null>,
    private interval: number,
    private changed: (value: T | null) => void,
    private failed: (error: unknown) => void,
    private same: (a: T | null, b: T | null) => boolean = (a, b) => a === b
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.candidate = null
    this.count = 0
    void this.poll(++this.generation)
  }

  stop(): void {
    this.running = false
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async poll(generation: number): Promise<void> {
    try {
      const value = await this.find()
      if (!this.running || generation !== this.generation) return
      const firstPoll = this.count === 0
      this.count = this.same(value, this.candidate) ? Math.min(this.count + 1, 2) : 1
      this.candidate = value
      // Report startup presence immediately; debounce later transitions while retaining stable poll notifications.
      if (firstPoll || this.count >= 2) this.changed(value)
    } catch (error) {
      if (this.running && generation === this.generation) this.failed(error)
    }
    if (this.running && generation === this.generation) {
      this.timer = setTimeout(() => void this.poll(generation), this.interval)
      this.timer.unref()
    }
  }
}
