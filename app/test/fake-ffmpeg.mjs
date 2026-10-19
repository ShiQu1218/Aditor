// Fake ffmpeg for export-cancellation tests (a real child process, not a mock).
// Behavior is controlled by environment variables:
//   FAKE_FFMPEG_SLEEP_MS      Default sleep duration in milliseconds (default 0)
//   FAKE_FFMPEG_SLEEP_MAP     JSON, e.g. {"_2": 30000}: use that duration when the output filename contains the key
//   FAKE_FFMPEG_EXIT          Exit code (default 0); FAKE_FFMPEG_EXIT_MAP works the same way by output filename
//   FAKE_FFMPEG_STDERR_BYTES  Number of bytes to write to stderr on failure (ends with TAIL_MARKER)
//   FAKE_FFMPEG_GRANDCHILD    "1" starts a sleeping grandchild process
//   FAKE_FFMPEG_PID_DIR       Directory for <output filename>.pids.json ({ ffmpeg, grandchild })
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

// Write a partial output first so tests can verify that the .partial file is removed.
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
