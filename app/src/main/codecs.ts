import http from 'http'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { codecsDir, engineCommand } from '../shared/paths'

export function openh264Url(): string {
  // Cisco official binary URL for win64
  return 'http://ciscobinary.openh264.org/openh264-2.3.1-win64.dll.bz2'
}

export function hasOpenH264(): boolean {
  const dir = codecsDir()
  if (!fs.existsSync(dir)) return false
  const files = fs.readdirSync(dir)
  return files.some((f) => f.toLowerCase().endsWith('.dll') && f.toLowerCase().includes('openh264'))
}

export async function downloadOpenH264(
  onProgress?: (ratio: number) => void
): Promise<string> {
  const dir = codecsDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const url = openh264Url()
  const bz2Path = path.join(dir, 'openh264-2.3.1-win64.dll.bz2')
  const dllPath = path.join(dir, 'openh264-2.3.1-win64.dll')

  // Download .bz2
  await new Promise<void>((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`下載 OpenH264 失敗: HTTP ${res.statusCode}`))
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let downloaded = 0
      const fileStream = fs.createWriteStream(bz2Path)

      res.on('data', (chunk) => {
        downloaded += chunk.length
        if (total > 0 && onProgress) {
          onProgress(downloaded / total)
        }
      })

      res.pipe(fileStream)
      fileStream.on('finish', () => {
        fileStream.close()
        resolve()
      })
      fileStream.on('error', reject)
    })
    req.on('error', reject)
  })

  // Decompress via python bz2
  const cmd = engineCommand(false)
  await new Promise<void>((resolve, reject) => {
    const decompressScript = `import bz2, sys\nwith open(sys.argv[1], 'rb') as f_in, open(sys.argv[2], 'wb') as f_out:\n    f_out.write(bz2.decompress(f_in.read()))\n`
    const proc = spawn(cmd.command, ['-c', decompressScript, bz2Path, dllPath])
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          fs.unlinkSync(bz2Path)
        } catch {}
        resolve()
      } else {
        reject(new Error(`解壓縮 OpenH264 失敗 (exit code ${code})`))
      }
    })
    proc.on('error', reject)
  })

  return dllPath
}
