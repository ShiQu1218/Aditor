import readline from 'readline'
import fs from 'fs'
import { createE2EHandler } from './fake-engine-e2e.mjs'

const mode = process.env.FAKE_ENGINE_MODE || 'normal'

if (mode === 'crash_on_start') {
  process.exit(1)
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function sendChunkedUtf8(obj) {
  const bytes = Buffer.from(JSON.stringify(obj) + '\n', 'utf8')
  const split = bytes.findIndex((byte, index) => byte >= 0x80 && index > 0)
  const at = split > 0 ? split + 1 : Math.floor(bytes.length / 2)
  process.stdout.write(bytes.subarray(0, at))
  setTimeout(() => process.stdout.write(bytes.subarray(at)), 20)
}

// Initial ready message
if (mode === 'chunked_ready') {
  const readyStr = JSON.stringify({ type: 'ready', engine_version: '0.1.0' }) + '\n'
  const half = Math.floor(readyStr.length / 2)
  process.stdout.write(readyStr.slice(0, half))
  setTimeout(() => {
    process.stdout.write(readyStr.slice(half))
  }, 20)
} else {
  send({ type: 'ready', engine_version: '0.1.0' })
}

// E2E mode: FAKE_ENGINE_MODE=e2e returns synthetic analysis results shaped like the engine (see fake-engine-e2e.mjs).
const e2eHandle = mode === 'e2e' ? createE2EHandler(send) : null

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
})

rl.on('line', (line) => {
  line = line.trim()
  if (!line) return
  let req
  try {
    req = JSON.parse(line)
  } catch (err) {
    send({ id: null, type: 'error', code: 'bad_request', message: String(err) })
    return
  }

  const { id, cmd, args } = req

  if (e2eHandle) {
    void e2eHandle(req)
    return
  }

  if (cmd === 'crash') {
    process.exit(1)
  } else if (cmd === 'probe') {
    send({ id, type: 'result', data: { path: args.path, duration: 120 } })
  } else if (cmd === 'analyze') {
    send({ id, type: 'progress', t: 30, duration: 120 })
    send({ id, type: 'progress', t: 60, duration: 120 })
    send({ id, type: 'result', data: { cache_path: '/path/to/cache.json', events: [] } })
  } else if (cmd === 'error_test') {
    send({ id, type: 'error', code: 'probe_failed', message: 'test error' })
  } else if (cmd === 'cancel') {
    send({ id, type: 'result', data: { cancelled: true, target: args.target } })
  } else if (cmd === 'chunked_result') {
    const res = JSON.stringify({ id, type: 'result', data: { ok: true } }) + '\n'
    const part = Math.floor(res.length / 2)
    process.stdout.write(res.slice(0, part))
    setTimeout(() => {
      process.stdout.write(res.slice(part))
    }, 20)
  } else if (cmd === 'multiline_result') {
    const l1 = JSON.stringify({ id, type: 'progress', t: 10, duration: 100 }) + '\n'
    const l2 = JSON.stringify({ id, type: 'result', data: { multi: true } }) + '\n'
    process.stdout.write(l1 + l2)
  } else if (cmd === 'unicode_result') {
    sendChunkedUtf8({ id, type: 'result', data: { path: 'D:/影片/中文.mp4' } })
  } else if (cmd === 'partial_unicode_crash') {
    const marker = process.env.FAKE_ENGINE_PARTIAL_MARKER
    if (marker && !fs.existsSync(marker)) {
      fs.writeFileSync(marker, 'crashed')
      const bytes = Buffer.from(JSON.stringify({ id, type: 'result', data: { path: 'D:/影片/中文.mp4' } }), 'utf8')
      const split = bytes.findIndex((byte, index) => byte >= 0x80 && index > 0)
      process.stdout.write(bytes.subarray(0, split + 1))
      setTimeout(() => process.exit(1), 0)
    } else {
      send({ id, type: 'result', data: { path: args.path } })
    }
  } else {
    send({ id, type: 'result', data: { echo: args } })
  }
})
