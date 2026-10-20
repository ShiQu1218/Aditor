// Fake ffmpeg for thumbnail tests: append argv to FAKE_LOG; FAKE_EXIT sets the exit code; write a partial output before exiting (the output file is the last argument).
import fs from 'fs'

const args = process.argv.slice(2)
const output = args[args.length - 1]
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args }) + '\n')
fs.writeFileSync(output, 'jpg-data')
process.exit(Number(process.env.FAKE_EXIT || 0))
