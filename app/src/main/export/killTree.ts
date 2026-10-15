import { spawn, type ChildProcess } from 'child_process'

export interface KillTreeDeps {
  platform?: NodeJS.Platform
  /** 測試用：取代 child_process.spawn（用來啟動 taskkill） */
  spawnImpl?: typeof spawn
  /** 測試用：取代 process.kill（非 Windows） */
  killImpl?: (pid: number, signal?: NodeJS.Signals | number) => boolean
}

/** taskkill 回報「找不到該 PID」＝程序已結束（視為成功）。 */
const TASKKILL_NOT_FOUND = 128

function alreadyExited(child: ChildProcess): boolean {
  return child.pid === undefined || child.exitCode !== null || child.signalCode !== null
}

/**
 * 終止子程序及其所有子孫程序，不丟錯（程序已結束亦可）。
 * - Windows：`taskkill /pid <pid> /T /F`（argv 陣列，不經 shell）；taskkill 無法啟動或失敗時退回 `child.kill('SIGKILL')`
 *   （只能殺直接子程序，是最後手段）。
 * - 其他平台：`process.kill(-pid, 'SIGKILL')` 殺整個程序群組——前提是子程序以 `detached: true` 啟動
 *   （成為自己的 process group leader），呼叫端（run.ts）負責；失敗時退回 `child.kill('SIGKILL')`。
 */
export async function killTree(child: ChildProcess, deps: KillTreeDeps = {}): Promise<void> {
  if (alreadyExited(child)) return
  const pid = child.pid as number
  const platform = deps.platform ?? process.platform

  const fallback = (): void => {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已結束
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
