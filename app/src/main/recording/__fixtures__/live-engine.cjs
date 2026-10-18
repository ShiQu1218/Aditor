// 假 live 引擎（計畫 7 合約 1）：依 FAKE_LIVE_MODE 輸出 JSON-lines。
const fs = require('fs')
const readline = require('readline')
const mode = process.env.FAKE_LIVE_MODE || 'normal'
const trace = process.env.FAKE_LIVE_TRACE
const state = process.env.FAKE_LIVE_STATE
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const ev = (id, t, type, counted = true) => ({ id, t, type, score: 1, damage_line: false, name_sig: null, counted,
  counted_reason: counted ? 'first' : 'duplicate', counted_override: null, source: 'auto' })
if (trace) fs.appendFileSync(trace, JSON.stringify({ argv: process.argv.slice(2) }) + '\n')

let events = [ev('a1000', 1, 'knock')]
let first = true
if (mode === 'crash-once') {
  first = !fs.existsSync(state)
  if (first) fs.writeFileSync(state, '1')
  else events = [ev('a500', 0.5, 'knock'), ev('a3000', 3, 'elim')]
}

send({ ev: 'ready', engine_version: '0.3.0', banner: [800, 180], spec: [480, 40], thumb: [640, 360] })
setTimeout(() => {
  if (mode === 'crash-once' && first) {
    send({ ev: 'snapshot', t: 1.5, events, spectating: [{ start: 0.2, end: 0.4 }] })
    send({ ev: 'stats', t: 2, frames: 8, skipped: 0, torn: 0, lag_s: 0.1, cpu_ms_per_frame: 1 })
    setTimeout(() => process.exit(3), 20)
    return
  }
  if (mode === 'garbage') process.stdout.write('{not json}\n')
  send({ ev: 'match_start', t: 0.5, reason: 'countdown' })
  send({ ev: 'snapshot', t: 2, events, spectating: [] })
}, 20)

let stopped = false
const finish = () => {
  if (stopped || mode === 'never-stop') return
  stopped = true
  if (trace) fs.appendFileSync(trace, JSON.stringify({ stop: true }) + '\n')
  send({ ev: 'match_end', t: 3.5, reason: 'lobby' })
  send({ ev: 'snapshot', t: 4, events: [...events, ev('a3500', 3.5, 'knock', false)], spectating: [{ start: 3.6, end: 3.9 }] })
  process.exit(0)
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (trace) fs.appendFileSync(trace, JSON.stringify({ stdin: line }) + '\n')
  if (JSON.parse(line).cmd === 'stop') finish()
}).on('close', finish)
if (mode === 'never-stop') setInterval(() => {}, 1000)
