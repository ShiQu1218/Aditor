import fs from 'fs'

/**
 * 純 TypeScript 的 bzip2 解壓縮（單一串流）。
 * 打包後的 App 沒有 Python，無法再用 `bz2` 模組解 OpenH264，因此在 Node 端自行解碼。
 * 會驗證每個區塊與整個串流的 CRC32；不支援已淘汰的 randomised 區塊。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
    t[i] = c >>> 0
  }
  return t
})()

function blockCrc(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0
  return ~crc >>> 0
}

class BitReader {
  private pos = 0
  private bitBuf = 0
  private bitCnt = 0
  constructor(private readonly data: Uint8Array) {}

  /** 讀 n 個位元（n <= 24），高位元在前。 */
  bits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.data.length) throw new Error('bz2: 資料意外結束')
      this.bitBuf = ((this.bitBuf << 8) | this.data[this.pos++]) >>> 0
      this.bitCnt += 8
    }
    const v = (this.bitBuf >>> (this.bitCnt - n)) & ((1 << n) - 1)
    this.bitCnt -= n
    this.bitBuf &= (1 << this.bitCnt) - 1
    return v
  }

  bit(): number {
    return this.bits(1)
  }
}

interface HuffTable {
  minLen: number
  maxLen: number
  limit: Int32Array
  base: Int32Array
  perm: Int32Array
}

function buildTable(lengths: Uint8Array, alphaSize: number): HuffTable {
  let minLen = 32
  let maxLen = 0
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i]
    if (lengths[i] < minLen) minLen = lengths[i]
  }
  const perm = new Int32Array(alphaSize)
  let pp = 0
  for (let i = minLen; i <= maxLen; i++) for (let j = 0; j < alphaSize; j++) if (lengths[j] === i) perm[pp++] = j
  const base = new Int32Array(23)
  const limit = new Int32Array(23)
  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++
  for (let i = 1; i < 23; i++) base[i] += base[i - 1]
  let vec = 0
  for (let i = minLen; i <= maxLen; i++) {
    vec += base[i + 1] - base[i]
    limit[i] = vec - 1
    vec <<= 1
  }
  for (let i = minLen + 1; i <= maxLen; i++) base[i] = ((limit[i - 1] + 1) << 1) - base[i]
  return { minLen, maxLen, limit, base, perm }
}

function readSymbol(br: BitReader, t: HuffTable): number {
  let n = t.minLen
  let v = br.bits(n)
  while (n <= t.maxLen && v > t.limit[n]) {
    n++
    v = (v << 1) | br.bit()
  }
  if (n > t.maxLen) throw new Error('bz2: Huffman 解碼錯誤')
  const idx = v - t.base[n]
  if (idx < 0 || idx >= t.perm.length) throw new Error('bz2: Huffman 解碼錯誤')
  return t.perm[idx]
}

export function bunzip2(input: Uint8Array): Buffer {
  const br = new BitReader(input)
  if (br.bits(8) !== 0x42 || br.bits(8) !== 0x5a || br.bits(8) !== 0x68) throw new Error('bz2: 不是 bzip2 資料')
  const level = br.bits(8) - 0x30
  if (level < 1 || level > 9) throw new Error('bz2: 標頭損毀')
  const maxBlock = level * 100000
  const tt = new Uint32Array(maxBlock)
  const out: Buffer[] = []
  let combined = 0

  for (;;) {
    const m1 = br.bits(24)
    const m2 = br.bits(24)
    const crcStored = ((br.bits(16) << 16) | br.bits(16)) >>> 0
    if (m1 === 0x177245 && m2 === 0x385090) {
      if (crcStored !== combined) throw new Error('bz2: 串流 CRC 不符')
      break
    }
    if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bz2: 區塊標頭損毀')
    if (br.bit()) throw new Error('bz2: 不支援 randomised 區塊')
    const origPtr = br.bits(24)

    // 符號對照表
    const inUse16 = br.bits(16)
    const seqToUnseq: number[] = []
    for (let i = 0; i < 16; i++) {
      if (inUse16 & (0x8000 >> i)) {
        const bitsUsed = br.bits(16)
        for (let j = 0; j < 16; j++) if (bitsUsed & (0x8000 >> j)) seqToUnseq.push(i * 16 + j)
      }
    }
    if (seqToUnseq.length === 0) throw new Error('bz2: 區塊沒有任何符號')
    const alphaSize = seqToUnseq.length + 2

    const nGroups = br.bits(3)
    if (nGroups < 2 || nGroups > 6) throw new Error('bz2: Huffman 群組數錯誤')
    const nSelectors = br.bits(15)
    if (nSelectors < 1) throw new Error('bz2: selector 數錯誤')
    const selMtf: number[] = Array.from({ length: nGroups }, (_, i) => i)
    const selectors = new Uint8Array(nSelectors)
    for (let i = 0; i < nSelectors; i++) {
      let j = 0
      while (br.bit()) {
        j++
        if (j >= nGroups) throw new Error('bz2: selector 損毀')
      }
      const v = selMtf[j]
      selMtf.splice(j, 1)
      selMtf.unshift(v)
      selectors[i] = v
    }

    const tables: HuffTable[] = []
    for (let g = 0; g < nGroups; g++) {
      const lens = new Uint8Array(alphaSize)
      let cur = br.bits(5)
      for (let s = 0; s < alphaSize; s++) {
        for (;;) {
          if (cur < 1 || cur > 20) throw new Error('bz2: 碼長損毀')
          if (!br.bit()) break
          cur += br.bit() ? -1 : 1
        }
        lens[s] = cur
      }
      tables.push(buildTable(lens, alphaSize))
    }

    // Huffman + MTF + 游程解碼 → tt 的低 8 位元
    const eob = alphaSize - 1
    const mtf = new Uint8Array(256)
    for (let i = 0; i < seqToUnseq.length; i++) mtf[i] = i
    const counts = new Int32Array(256)
    let nblock = 0
    let run = 0
    let runPos = 1
    let selIdx = 0
    let groupLeft = 0
    let table = tables[0]
    const flushRun = (): void => {
      if (run === 0) return
      const byte = seqToUnseq[mtf[0]]
      if (nblock + run > maxBlock) throw new Error('bz2: 區塊超過大小上限')
      counts[byte] += run
      tt.fill(byte, nblock, nblock + run)
      nblock += run
      run = 0
      runPos = 1
    }
    for (;;) {
      if (groupLeft === 0) {
        if (selIdx >= nSelectors) throw new Error('bz2: selector 用盡')
        table = tables[selectors[selIdx++]]
        groupLeft = 50
      }
      groupLeft--
      const sym = readSymbol(br, table)
      if (sym <= 1) {
        run += runPos << sym
        runPos <<= 1
        if (run > maxBlock) throw new Error('bz2: 游程過長')
        continue
      }
      flushRun()
      if (sym === eob) break
      const idx = sym - 1
      const v = mtf[idx]
      mtf.copyWithin(1, 0, idx)
      mtf[0] = v
      if (nblock >= maxBlock) throw new Error('bz2: 區塊超過大小上限')
      const byte = seqToUnseq[v]
      counts[byte]++
      tt[nblock++] = byte
    }
    if (nblock === 0 || origPtr >= nblock) throw new Error('bz2: origPtr 超出範圍')

    // 反向 BWT
    const cftab = new Int32Array(256)
    let sum = 0
    for (let i = 0; i < 256; i++) {
      cftab[i] = sum
      sum += counts[i]
    }
    for (let i = 0; i < nblock; i++) {
      const uc = tt[i] & 0xff
      tt[cftab[uc]++] |= i << 8
    }

    // 逆向第一階段 RLE（連續 4 個相同位元組後接重複次數）
    const chunks: Buffer[] = []
    let cur = Buffer.allocUnsafe(nblock + 1024)
    let curLen = 0
    const put = (b: number, times: number): void => {
      if (curLen + times > cur.length) {
        chunks.push(cur.subarray(0, curLen))
        cur = Buffer.allocUnsafe(Math.max(nblock + 1024, times))
        curLen = 0
      }
      cur.fill(b, curLen, curLen + times)
      curLen += times
    }
    let tPos = tt[origPtr] >>> 8
    let last = -1
    let same = 0
    for (let i = 0; i < nblock; i++) {
      const e = tt[tPos]
      tPos = e >>> 8
      const ch = e & 0xff
      if (same === 4) {
        if (ch > 0) put(last, ch)
        same = 0
        last = -1
        continue
      }
      if (ch === last) same++
      else {
        same = 1
        last = ch
      }
      put(ch, 1)
    }
    chunks.push(cur.subarray(0, curLen))
    const blockOut = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
    const crc = blockCrc(blockOut)
    if (crc !== crcStored) throw new Error('bz2: 區塊 CRC 不符')
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0
    out.push(blockOut)
  }
  return Buffer.concat(out)
}

/** 解壓縮 `src` 到 `dst`（整檔載入記憶體；OpenH264 的 DLL 不到 1 MB）。 */
export async function decompressBz2File(src: string, dst: string): Promise<void> {
  const data = await fs.promises.readFile(src)
  fs.writeFileSync(dst, bunzip2(data))
}
