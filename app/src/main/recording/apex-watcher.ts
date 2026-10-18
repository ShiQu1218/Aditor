import { execFile } from 'child_process'

export function parseApexPid(output: string): number | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^"(r5apex(?:_dx12)?\.exe)","(\d+)"/i.exec(line.trim())
    const pid = match ? Number(match[2]) : 0
    if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff) return pid
  }
  return null
}

export function findApexPid(): Promise<number | null> {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq r5apex*', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 10000 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(parseApexPid(stdout))
      })
  })
}

/** 輪詢不重疊；程序查詢失敗不當作遊戲關閉。 */
export class ApexWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private generation = 0
  private candidate: number | null = null
  private count = 0

  constructor(
    private find: () => Promise<number | null>,
    private interval: number,
    private changed: (pid: number | null) => void,
    private failed: (error: unknown) => void
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
      const pid = await this.find()
      if (!this.running || generation !== this.generation) return
      this.count = pid === this.candidate ? this.count + 1 : 1
      this.candidate = pid
      if (this.count >= 2) {
        this.changed(pid)
      }
    } catch (error) {
      this.count = 0
      if (this.running && generation === this.generation) this.failed(error)
    }
    if (this.running && generation === this.generation) {
      this.timer = setTimeout(() => void this.poll(generation), this.interval)
      this.timer.unref()
    }
  }
}
