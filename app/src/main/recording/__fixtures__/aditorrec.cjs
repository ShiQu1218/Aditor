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
    if (mode === 'probe-exit') {
      process.stderr.write('private device name\nADITORREC_DIAG probe_stage=probe_')
      return setTimeout(() => {
        process.stderr.write('send probe_encoder=av1_nvenc\nADITORREC_DIAG probe_stage=private probe_encoder=secret\n')
        process.exit(7)
      }, 20)
    }
    if (mode === 'policy-exit') return process.exit(0xC0E90002)
    if (mode === 'hello-timeout') return
    if (mode === 'invalid-json') return process.stdout.write('{oops}\n')
    if (mode === 'oversize') return process.stdout.write('x'.repeat(65537))
    if (mode === 'stderr-exit') {
      process.stderr.write('x'.repeat(70000) + '最後的錯誤')
      return process.exit(7)
    }
    const gpus = [
      { id: '10de:2684', name: 'NVIDIA GeForce RTX 5080', vendor: 'nvidia', encoders: ['hevc_nvenc', 'h264_nvenc'] },
      { id: '8086:46a6', name: 'Intel Iris Xe Graphics', vendor: 'intel', encoders: ['av1_qsv'] }
    ]
    const hello = (reported = gpus) => send({ id: req.id, ok: true, version: '0.1.0', encoders: ['hevc_nvenc', 'h264_nvenc', 'av1_qsv'],
      ...(reported === null ? {} : { gpus: reported }),
      audio: { render: [{ id: 'default', name: '系統聲音', default: true }], capture: [] } })
    if (mode === 'slow-hello') return setTimeout(hello, 200)
    if (mode === 'hello-legacy') return hello(null)
    if (mode === 'hello-bad-gpus') return hello([{ id: '10de:2684', name: 'NVIDIA GeForce RTX 5080', vendor: 'nvidia' }])
    return hello()
  }
  if (req.cmd === 'start') {
    if (mode === 'no-hw') return send({ id: req.id, ok: false, code: 'no_hw_encoder', message: '沒有硬體編碼器' })
    if (mode === 'audio-device-invalidated') return send({ id: req.id, ok: false, code: 'audio_failed', message: 'audio_failed: Failed to activate audio device: The audio device has been invalidated. (0x88890004)' })
    if (mode === 'audio-device-missing') return send({ id: req.id, ok: false, code: 'audio_failed', message: 'audio_failed: Specified audio device not found: The system cannot find the file specified. (0x80070002)' })
    if (mode === 'no-hw-nvidia') return send({ id: req.id, ok: false, code: 'no_hw_encoder', message: 'no_hw_encoder: nvidia_driver_outdated: The NVIDIA driver supports NVENC API 12.2 but 13.0 is required; update the NVIDIA driver to 570.0 or newer and try again (GPUs whose newest driver is older cannot use NVENC); hevc_nvenc: Open encoder failed: Function not implemented (-40)' })
    if (mode === 'hook-unavailable' && req.capture === 'hook') {
      return send({ id: req.id, ok: false, code: 'hook_unavailable', message: 'hook_unavailable: 注入逾時' })
    }
    if (mode === 'start-stall') return send({ id: req.id, ok: true })
    sessionDir = req.session_dir
    if (process.env.FAKE_SEGMENT_DIR) {
      for (const file of fs.readdirSync(process.env.FAKE_SEGMENT_DIR)) {
        fs.copyFileSync(path.join(process.env.FAKE_SEGMENT_DIR, file), path.join(sessionDir, file))
      }
    }
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ started_at: new Date().toISOString() }))
    send({ ev: 'started', encoder: req.encode === null ? null : 'hevc_nvenc', width: 1920, height: 1080, fps: 60, shm: 'Local\\fake' })
    if (mode === 'warning') send({ ev: 'warning', code: 'game_audio_unavailable', message: '無法只錄遊戲聲音，已改錄系統聲音。' })
    if (mode === 'audio-warnings') {
      for (const code of ['audio_device_missing', 'audio_source_lost', 'audio_capture_stalled', 'game_audio_unavailable', 'unrelated_warning']) {
        send({ ev: 'warning', code, message: `Synthetic ${code} warning` })
      }
    }
    // The recorder downgrades a missing default endpoint to a warning and keeps recording with silence.
    if (mode === 'audio-default-missing') send({ ev: 'warning', code: 'audio_device_missing',
      message: 'System audio is enabled but no matching audio device was found; recording will continue with silence for that source: audio_device_missing: No default audio device' })
    send({ id: req.id, ok: true })
    if (req.encode === null) return
    if (mode === 'match') {
      const segment = (seq) => {
        const entry = { seq, pts: (seq - 1) * 2, dur: 2 }
        fs.writeFileSync(path.join(sessionDir, `seg_${String(seq).padStart(6, '0')}.m4s`), `${entry.pts}|`)
        fs.appendFileSync(path.join(sessionDir, 'index.jsonl'), JSON.stringify(entry) + '\n')
        send({ ev: 'segment', ...entry })
      }
      for (let seq = 1; seq <= 4; seq++) segment(seq)
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.FAKE_POST_PAD_GATE)) return
        clearInterval(timer)
        for (let seq = 5; seq < 5 + Number(process.env.FAKE_TAIL_SEGMENTS || 2); seq++) segment(seq)
      }, 10)
      return
    }
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
    if (mode === 'async-hook-unavailable' && req.capture === 'hook') setTimeout(() => {
      send({ ev: 'error', code: 'hook_unavailable', message: 'hook_unavailable: 遊戲材質遺失' })
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
