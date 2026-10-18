const fs = require('fs')
const path = require('path')
const readline = require('readline')
const mode = process.env.FAKE_RECORDER_MODE || 'normal'
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
let sessionDir
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  if (process.env.FAKE_RECORDER_TRACE) fs.appendFileSync(process.env.FAKE_RECORDER_TRACE, line + '\n')
  if (req.cmd === 'hello') {
    if (mode === 'hello-timeout') return
    if (mode === 'invalid-json') return process.stdout.write('{oops}\n')
    if (mode === 'oversize') return process.stdout.write('x'.repeat(65537))
    if (mode === 'stderr-exit') {
      process.stderr.write('x'.repeat(70000) + '最後的錯誤')
      return process.exit(7)
    }
    const hello = () => send({ id: req.id, ok: true, version: '0.1.0', encoders: ['hevc_nvenc', 'h264_nvenc'],
      audio: { render: [{ id: 'default', name: '系統聲音', default: true }], capture: [] } })
    if (mode === 'slow-hello') return setTimeout(hello, 200)
    return hello()
  }
  if (req.cmd === 'start') {
    if (mode === 'no-hw') return send({ id: req.id, ok: false, code: 'no_hw_encoder', message: '沒有硬體編碼器' })
    if (mode === 'start-stall') return send({ id: req.id, ok: true })
    sessionDir = req.session_dir
    if (process.env.FAKE_SEGMENT_DIR) {
      for (const file of fs.readdirSync(process.env.FAKE_SEGMENT_DIR)) {
        fs.copyFileSync(path.join(process.env.FAKE_SEGMENT_DIR, file), path.join(sessionDir, file))
      }
    }
    send({ ev: 'started', encoder: 'hevc_nvenc', width: 1920, height: 1080, fps: 60, shm: 'Local\\fake' })
    send({ id: req.id, ok: true })
    send({ ev: 'segment', seq: 1, pts: 0, dur: 2 })
    send({ ev: 'segment', seq: 2, pts: 2, dur: 2 })
    send({ ev: 'stats', fps_in: 60, fps_enc: 60, dropped: 3, queue: 0 })
    send({ ev: 'window_lost' })
    send({ ev: 'window_found', width: 1920, height: 1080, monitor: false })
    if (mode === 'crash') setTimeout(() => process.exit(9), 30)
    if (mode === 'async-no-hw') setTimeout(() => {
      send({ ev: 'error', code: 'no_hw_encoder', message: '沒有硬體編碼器' })
      send({ ev: 'stopped', reason: 'error' })
    }, 30)
    return
  }
  if (req.cmd === 'stop') {
    if (mode === 'stop-stall') return
    send({ ev: 'stopped', reason: 'requested' })
    send({ id: req.id, ok: true })
    return
  }
  setTimeout(() => send({ id: req.id, ok: true, value: req.value }), req.delay || 0)
}).on('close', () => process.exit(0))
