/**
 * fMP4 初始化段（init.mp4）的最小 box 解析：取出各軌的取樣描述，組成 MSE 用的
 * RFC 6381 MIME 字串（例如 `video/mp4; codecs="hvc1.1.6.L150.90, mp4a.40.2"`）。
 * 只讀 ftyp／moov 內需要的 box，不解碼影像；格式不符一律丟出錯誤。
 */

interface Box { type: string; start: number; end: number }

/** 容器 box：子 box 直接接在 8 位元組檔頭之後。 */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
/** VisualSampleEntry 檔頭後的固定欄位（SampleEntry 8＋影像欄位 70 位元組），之後才是子 box。 */
const VISUAL_ENTRY_FIELDS = 8 + 70
/** AudioSampleEntry 檔頭後的固定欄位（SampleEntry 8＋聲音欄位 20 位元組）。 */
const AUDIO_ENTRY_FIELDS = 8 + 20
const MAX_DEPTH = 8

function boxes(buf: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out: Box[] = []
  let offset = start
  while (offset + 8 <= end) {
    let size = view.getUint32(offset)
    const type = String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7])
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) throw new Error('MP4 box 大小欄位不完整')
      const big = view.getBigUint64(offset + 8)
      if (big > BigInt(end - offset)) throw new Error(`MP4 box ${type} 超出範圍`)
      size = Number(big)
      header = 16
    } else if (size === 0) size = end - offset
    if (size < header || offset + size > end) throw new Error(`MP4 box ${type} 大小無效`)
    out.push({ type, start: offset + header, end: offset + size })
    offset += size
  }
  return out
}

function find(buf: Uint8Array, box: Box, type: string, skip = 0): Box | undefined {
  return boxes(buf, box.start + skip, box.end).find((b) => b.type === type)
}

function hex2(n: number): string { return n.toString(16).padStart(2, '0') }

function avcCodec(fourcc: string, buf: Uint8Array, avcC: Box): string {
  if (avcC.end - avcC.start < 4) throw new Error('avcC 太短')
  return `${fourcc}.${hex2(buf[avcC.start + 1])}${hex2(buf[avcC.start + 2])}${hex2(buf[avcC.start + 3])}`.toLowerCase()
}

/** ISO/IEC 14496-15 Annex E：hvc1.[空間]profile.相容旗標（位元反轉）.[L|H]level[.限制位元組…] */
function hevcCodec(fourcc: string, buf: Uint8Array, hvcC: Box): string {
  if (hvcC.end - hvcC.start < 13) throw new Error('hvcC 太短')
  const p = hvcC.start
  const space = buf[p + 1] >> 6
  const tier = (buf[p + 1] >> 5) & 1
  const profile = buf[p + 1] & 0x1f
  let flags = 0
  for (let i = 0; i < 4; i++) flags = (flags << 8) | buf[p + 2 + i]
  let reversed = 0
  for (let i = 0; i < 32; i++) reversed = (reversed << 1) | ((flags >>> i) & 1)
  const constraints = Array.from(buf.subarray(p + 6, p + 12))
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop()
  const parts = [fourcc, `${['', 'A', 'B', 'C'][space]}${profile}`, (reversed >>> 0).toString(16).toUpperCase(),
    `${tier ? 'H' : 'L'}${buf[p + 12]}`, ...constraints.map((b) => b.toString(16).toUpperCase())]
  return parts.join('.')
}

/** AV1 Codec ISOBMFF §5：av01.profile.level+tier.bitDepth */
function av1Codec(buf: Uint8Array, av1C: Box): string {
  if (av1C.end - av1C.start < 3) throw new Error('av1C 太短')
  const p = av1C.start
  const profile = buf[p + 1] >> 5
  const level = buf[p + 1] & 0x1f
  const tier = buf[p + 2] >> 7
  const high = (buf[p + 2] >> 6) & 1
  const twelve = (buf[p + 2] >> 5) & 1
  const depth = high ? (twelve ? 12 : 10) : 8
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`
}

/** 讀 MPEG-4 描述子長度（每位元組 7 位元，最多 4 位元組）。 */
function descriptor(buf: Uint8Array, offset: number, end: number): { tag: number; body: number; end: number } {
  if (offset + 2 > end) throw new Error('esds 描述子不完整')
  const tag = buf[offset]
  let length = 0
  let i = offset + 1
  for (let n = 0; n < 4; n++, i++) {
    if (i >= end) throw new Error('esds 描述子長度不完整')
    length = (length << 7) | (buf[i] & 0x7f)
    if (!(buf[i] & 0x80)) { i++; break }
  }
  if (i + length > end) throw new Error('esds 描述子超出範圍')
  return { tag, body: i, end: i + length }
}

/** esds → mp4a.<objectTypeIndication hex>.<audioObjectType>（例如 mp4a.40.2）。 */
function mp4aCodec(buf: Uint8Array, esds: Box): string {
  const es = descriptor(buf, esds.start + 4, esds.end)
  if (es.tag !== 0x03) throw new Error('esds 缺少 ES_Descriptor')
  const flags = buf[es.body + 2]
  let offset = es.body + 3
  if (flags & 0x80) offset += 2
  if (flags & 0x40) offset += 1 + buf[offset]
  if (flags & 0x20) offset += 2
  const dc = descriptor(buf, offset, es.end)
  if (dc.tag !== 0x04) throw new Error('esds 缺少 DecoderConfigDescriptor')
  const oti = buf[dc.body]
  let codec = `mp4a.${hex2(oti)}`
  const dsiStart = dc.body + 13
  if (dsiStart < dc.end) {
    const dsi = descriptor(buf, dsiStart, dc.end)
    if (dsi.tag === 0x05 && dsi.end > dsi.body) {
      let aot = buf[dsi.body] >> 3
      if (aot === 31 && dsi.end > dsi.body + 1) aot = 32 + (((buf[dsi.body] & 7) << 3) | (buf[dsi.body + 1] >> 5))
      codec += `.${aot}`
    }
  }
  return codec
}

function sampleCodec(buf: Uint8Array, entry: Box): string {
  const fourcc = entry.type
  if (['avc1', 'avc3', 'hvc1', 'hev1', 'av01'].includes(fourcc)) {
    const child = { ...entry, start: entry.start + VISUAL_ENTRY_FIELDS }
    if (fourcc.startsWith('avc')) {
      const avcC = find(buf, child, 'avcC')
      if (!avcC) throw new Error('缺少 avcC')
      return avcCodec(fourcc, buf, avcC)
    }
    if (fourcc === 'av01') {
      const av1C = find(buf, child, 'av1C')
      if (!av1C) throw new Error('缺少 av1C')
      return av1Codec(buf, av1C)
    }
    const hvcC = find(buf, child, 'hvcC')
    if (!hvcC) throw new Error('缺少 hvcC')
    return hevcCodec(fourcc, buf, hvcC)
  }
  if (fourcc === 'mp4a') {
    const esds = find(buf, { ...entry, start: entry.start + AUDIO_ENTRY_FIELDS }, 'esds')
    return esds ? mp4aCodec(buf, esds) : 'mp4a.40.2'
  }
  if (fourcc === 'Opus') return 'opus'
  throw new Error(`不支援的編碼：${fourcc}`)
}

/** 回傳每一軌的 codecs 字串（影像在前）。 */
export function initCodecs(buf: Uint8Array): string[] {
  const top = boxes(buf, 0, buf.byteLength)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) throw new Error('init.mp4 缺少 moov')
  const video: string[] = []
  const audio: string[] = []
  const walk = (box: Box, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error('MP4 box 巢狀過深')
    for (const child of boxes(buf, box.start, box.end)) {
      if (child.type === 'stsd') {
        // FullBox（4）＋ entry_count（4）之後是各取樣描述
        for (const entry of boxes(buf, child.start + 8, child.end)) {
          const codec = sampleCodec(buf, entry)
          ;(codec.startsWith('mp4a') || codec === 'opus' ? audio : video).push(codec)
        }
      } else if (CONTAINERS.has(child.type)) walk(child, depth + 1)
    }
  }
  walk(moov, 0)
  if (video.length === 0) throw new Error('init.mp4 沒有影像軌')
  return [...video, ...audio]
}

/** `video/mp4; codecs="…"`（MediaSource.isTypeSupported／addSourceBuffer 用）。 */
export function initMimeType(buf: Uint8Array): string {
  return `video/mp4; codecs="${initCodecs(buf).join(', ')}"`
}

/** 快取 `video.codec` 用的編碼名稱（與 ffprobe 命名相同）。 */
export function codecName(codecs: string[]): string {
  const v = codecs[0] ?? ''
  if (v.startsWith('hvc1') || v.startsWith('hev1')) return 'hevc'
  if (v.startsWith('avc')) return 'h264'
  if (v.startsWith('av01')) return 'av1'
  return v
}
