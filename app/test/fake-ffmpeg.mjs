// 假 ffmpeg：供匯出取消測試使用（真實子程序，不 mock）。
// 行為由環境變數控制：
//   FAKE_FFMPEG_SLEEP_MS      預設睡眠毫秒（預設 0）
//   FAKE_FFMPEG_SLEEP_MAP     JSON，如 {"_2": 30000}：輸出檔名含該 key 時改用該睡眠值
//   FAKE_FFMPEG_EXIT          結束碼（預設 0）；FAKE_FFMPEG_EXIT_MAP 同理（依輸出檔名）
//   FAKE_FFMPEG_STDERR_BYTES  失敗時往 stderr 寫多少位元組（尾端標記 TAIL_MARKER）
//   FAKE_FFMPEG_GRANDCHILD    "1" 時啟動一個會睡眠的孫程序
//   FAKE_FFMPEG_PID_DIR       目錄；寫入 <輸出檔名>.pids.json（{ ffmpeg, grandchild }）
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

const args = process.argv.slice(2)
const output = args[args.length - 1]
const base = path.basename(output)

function pick(valueEnv, mapEnv, fallback) {
  const map = process.env[mapEnv] ? JSON.parse(process.env[mapEnv]) : {}
  for (const key of Object.keys(map)) {
    if (base.includes(key)) return Number(map[key])
  }
  return process.env[valueEnv] !== undefined ? Number(process.env[valueEnv]) : fallback
}

const sleepMs = pick('FAKE_FFMPEG_SLEEP_MS', 'FAKE_FFMPEG_SLEEP_MAP', 0)
const exitCode = pick('FAKE_FFMPEG_EXIT', 'FAKE_FFMPEG_EXIT_MAP', 0)

// 先寫出「寫到一半」的輸出檔，讓測試能驗證 .partial 檔被清掉
fs.writeFileSync(output, 'partial-data')

let grandchild = null
if (process.env.FAKE_FFMPEG_GRANDCHILD === '1') {
  grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}
if (process.env.FAKE_FFMPEG_PID_DIR) {
  fs.writeFileSync(
    path.join(process.env.FAKE_FFMPEG_PID_DIR, base + '.pids.json'),
    JSON.stringify({ ffmpeg: process.pid, grandchild: grandchild ? grandchild.pid : null })
  )
}

process.stdout.write('out_time_us=1000000\nprogress=continue\n')

setTimeout(() => {
  if (grandchild) {
    try {
      grandchild.kill()
    } catch {}
  }
  if (exitCode !== 0) {
    const n = Number(process.env.FAKE_FFMPEG_STDERR_BYTES || 0)
    process.stderr.write('x'.repeat(Math.max(0, n)) + 'TAIL_MARKER')
    process.exit(exitCode)
  }
  fs.writeFileSync(output, 'complete-data')
  process.stdout.write('out_time_us=2000000\nprogress=end\n')
  process.exit(0)
}, sleepMs)
