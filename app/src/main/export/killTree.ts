import { spawn, type ChildProcess } from 'child_process'

export interface KillTreeDeps {
  platform?: NodeJS.Platform
  /** Test override for child_process.spawn (used to launch taskkill). */
  spawnImpl?: typeof spawn
  /** Test override for process.kill (non-Windows). */
  killImpl?: (pid: number, signal?: NodeJS.Signals | number) => boolean
}

/** If taskkill reports that the PID was not found, the process already exited (treat as success). */
const TASKKILL_NOT_FOUND = 128

function alreadyExited(child: ChildProcess): boolean {
  return child.pid === undefined || child.exitCode !== null || child.signalCode !== null
}

/**
 * Kill a child process and all descendants without throwing (including when the process has already exited).
 * - Windows: run `taskkill /pid <pid> /T /F` (argv array, no shell); if taskkill cannot start or fails, fall back to `child.kill('SIGKILL')`
 *   (kills only the direct child and is a last resort).
 * - Other platforms: `process.kill(-pid, 'SIGKILL')` kills the process group, provided the child was started with `detached: true`
 *   (making it the process-group leader); the caller (run.ts) is responsible. On failure, fall back to `child.kill('SIGKILL')`.
 */
export async function killTree(child: ChildProcess, deps: KillTreeDeps = {}): Promise<void> {
  if (alreadyExited(child)) return
  const pid = child.pid as number
  const platform = deps.platform ?? process.platform

  const fallback = (): void => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already exited.
    }
  }

  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      try {
        const tk = (deps.spawnImpl ?? spawn)('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          shell: false
        })
        tk.on('error', () => {
          fallback()
          done()
        })
        tk.on('close', (code: number | null) => {
          if (code !== 0 && code !== TASKKILL_NOT_FOUND) fallback()
          done()
        })
      } catch {
        fallback()
        done()
      }
    })
    return
  }

  try {
    ;(deps.killImpl ?? process.kill)(-pid, 'SIGKILL')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') fallback()
  }
}
