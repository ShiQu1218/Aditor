// Fake ffmpeg for proxy tests: only -c:v encoders listed in FAKE_OK_ENCODERS (comma-separated) succeed; others exit with code 1.
// Append each call's JSON (argv, PATH) to the file named by FAKE_LOG so tests can verify encoder order and PATH.
// FAKE_SLEEP_MS makes the process sleep longer (for cancellation tests). The output file is the last argument.
import fs from 'fs'

const args = process.argv.slice(2)
const output = args[args.length - 1]
const enc = args[args.indexOf('-c:v') + 1]
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, enc, path: process.env.PATH }) + '\n')
const ok = (process.env.FAKE_OK_ENCODERS || '').split(',').includes(enc)
fs.writeFileSync(output, 'partial-data')
setTimeout(() => {
  if (!ok) {
    process.stderr.write(`Unknown encoder or init failed: ${enc}`)
    process.exit(1)
  }
  fs.writeFileSync(output, 'proxy-data')
  process.exit(0)
}, Number(process.env.FAKE_SLEEP_MS || 0))
