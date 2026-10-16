// 假 ffmpeg（縮圖測試用）：FAKE_LOG 附加 argv；FAKE_EXIT 為結束碼；輸出檔是最後一個引數，先寫半成品再結束。
import fs from 'fs'

const args = process.argv.slice(2)
const output = args[args.length - 1]
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args }) + '\n')
fs.writeFileSync(output, 'jpg-data')
process.exit(Number(process.env.FAKE_EXIT || 0))
