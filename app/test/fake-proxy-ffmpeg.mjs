// 假 ffmpeg（代理檔測試用）：只有 FAKE_OK_ENCODERS（逗號分隔）內的 -c:v 編碼器會成功，其餘結束碼 1。
// FAKE_LOG 指向的檔案會附加每次呼叫的 JSON（argv、PATH），讓測試驗證編碼器嘗試順序與 PATH。
// FAKE_SLEEP_MS 讓程序多睡一會兒（取消測試）。輸出檔是最後一個引數。
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
