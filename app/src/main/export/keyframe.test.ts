import { describe, it, expect } from 'vitest'
import path from 'path'
import {
  cleanCutEnd,
  createAudioProbe,
  presentationEnd,
  createCutLookup,
  cutProbeArgs,
  defaultFfprobePath,
  lookupCopyCuts,
  measureMediaEnds,
  parseMediaEnd,
  pickCopyCut
} from './keyframe'

type Pkt = { pts: number | string; dts?: number | string; flags: string }
const doc = (packets: Pkt[], timeBase = '1/1000', startTime = '0.000000') => ({
  packets,
  streams: [{ time_base: timeBase }],
  format: { start_time: startTime }
})
/** 60 fps, no B-frames: dts=pts, tb 1/60. */
const ipp = (from: number, to: number, gop: number): Pkt[] =>
  Array.from({ length: to - from }, (_, i) => ({ pts: from + i, dts: from + i, flags: (from + i) % gop === 0 ? 'K__' : '___' }))

it('returns unknown when audio-track probing fails or is cancelled, without treating it as no audio track', async () => {
  const probe = createAudioProbe(path.join(__dirname, '__missing_ffprobe__'))
  await expect(probe('source.mp4')).resolves.toBeNull()
  const ac = new AbortController()
  ac.abort()
  await expect(probe('source.mp4', ac.signal)).resolves.toBeNull()
})

describe('pickCopyCut: keyframe', () => {
  it('starts on the last keyframe at or before the clip start, ignoring non-key packets and later keyframes', () => {
    const d = doc(ipp(600, 1500, 120), '1/60')
    expect(pickCopyCut(d, 13.4, 21.7)?.keyframe).toBe(12)
    expect(pickCopyCut(d, 12, 21.7)?.keyframe).toBe(12)
    expect(pickCopyCut(d, 11.99, 21.7)?.keyframe).toBe(10)
  })

  it('uses the stream time base and makes times relative to the source start_time (same basis as ffmpeg -ss)', () => {
    const d = doc([{ pts: 200704, dts: 200448, flags: 'K__' }, { pts: 107008, dts: 106752, flags: 'K__' }], '1/15360', '1.000000')
    expect(pickCopyCut(d, 15.2, 20)?.keyframe).toBeCloseTo(200704 / 15360 - 1, 9)
  })

  it('returns null for missing or malformed data', () => {
    expect(pickCopyCut(null, 1, 2)).toBeNull()
    expect(pickCopyCut({}, 1, 2)).toBeNull()
    expect(pickCopyCut(doc([{ pts: 5000, flags: 'K__' }], 'bad'), 6, 7)).toBeNull()
    expect(pickCopyCut(doc([{ pts: 'N/A', flags: 'K__' }]), 6, 7)).toBeNull()
    // Only keyframes later than the start.
    expect(pickCopyCut(doc([{ pts: 7000, flags: 'K__' }]), 6, 8)).toBeNull()
  })
})

describe('cleanCutEnd: no hole at the tail of a B-frame stream copy', () => {
  // Decode order I0 P3 B1 B2 P6 B4 B5 … (one second per frame for readability).
  const ibbp = [
    { pts: 0, dts: -1 },
    { pts: 3, dts: 0 },
    { pts: 1, dts: 1 },
    { pts: 2, dts: 2 },
    { pts: 6, dts: 3 },
    { pts: 4, dts: 4 },
    { pts: 5, dts: 5 },
    { pts: 9, dts: 6 },
    { pts: 7, dts: 7 },
    { pts: 8, dts: 8 }
  ]

  it('extends the end until every frame shown before the last kept frame is kept too', () => {
    // dts < 4 retains P6 but drops B4 and B5 (display through 6 with two missing frames) → extend past dts 5.
    expect(cleanCutEnd(ibbp, 4)).toBeCloseTo(5.5, 9)
    // dts < 5.2 also drops B5 → extend to 5.5.
    expect(cleanCutEnd(ibbp, 5.2)).toBeCloseTo(5.5, 9)
  })

  it('a clean end only moves to the midpoint between DTS values (same packets, no rounding ambiguity)', () => {
    expect(cleanCutEnd(ibbp, 6)).toBeCloseTo(5.5, 9)
    const noB = [0, 1, 2, 3].map((t) => ({ pts: t, dts: t }))
    expect(cleanCutEnd(noB, 2.4)).toBeCloseTo(2.5, 9)
    expect(cleanCutEnd(noB, 9)).toBeCloseTo(3.001, 9)
  })

  it('leaves the end alone when DTS is unknown or nothing would be kept', () => {
    expect(cleanCutEnd([{ pts: 1, dts: null }], 4)).toBe(4)
    expect(cleanCutEnd(ibbp, -5)).toBe(-5)
  })

  it('pickCopyCut applies it to the packets around the clip end', () => {
    const tb = '1/1'
    const pk = (p: { pts: number; dts: number }, i: number): Pkt => ({ pts: p.pts + 20, dts: p.dts + 20, flags: i === 0 ? 'K__' : '___' })
    const d = doc([{ pts: 10, dts: 9, flags: 'K__' }, ...ibbp.map(pk)], tb)
    // Cut video at 25.5 (keep B24 and B25); the last retained frame displays through 26+1=27, and cut audio 10 ms before 27.
    const cut = pickCopyCut(d, 12, 24)!
    expect(cut.keyframe).toBe(10)
    expect(cut.videoCut).toBeCloseTo(25.5, 9)
    expect(cut.end).toBeCloseTo(26.99, 9)
  })

  it('presentationEnd is the last kept frame plus one frame duration', () => {
    expect(presentationEnd(ibbp, 5.5)).toBe(7)
    expect(presentationEnd(ibbp, -3)).toBeNull()
  })
})

describe('cutProbeArgs', () => {
  it('reads video packets in two absolute windows: 10 s before the start, and around the end', () => {
    const args = cutProbeArgs('E:/v.mkv', 45.1, 52.3)
    expect(args[args.indexOf('-read_intervals') + 1]).toBe('35.100%47.100,50.300%54.300')
    expect(args[args.indexOf('-show_entries') + 1]).toContain('packet=pts,dts,flags')
    expect(args).toContain('v:0')
    expect(args[args.length - 1]).toBe('E:/v.mkv')
    const early = cutProbeArgs('a.mp4', 3, 4)
    expect(early[early.indexOf('-read_intervals') + 1]).toBe('0.000%5.000,2.000%6.000')
  })
})

describe('parseMediaEnd', () => {
  it('is the largest pts + duration over all packets (a B-frame tail can end after the muxer-reported duration)', () => {
    expect(parseMediaEnd('8.083333,0.016667\n8.150000,0.016667\n8.100000,0.016667\n\n')).toBeCloseTo(8.166667, 6)
    expect(parseMediaEnd('0.011,0.021333\r\n9.696,0.021333\r\n')).toBeCloseTo(9.717333, 6)
  })
  it('null when nothing usable was printed', () => {
    expect(parseMediaEnd('')).toBeNull()
    expect(parseMediaEnd('N/A,N/A\n')).toBeNull()
  })
})

describe('lookupCopyCuts / measureMediaEnds', () => {
  it('queries each distinct (source, start, end) once and maps results back in item order', async () => {
    const calls: string[] = []
    const lookup = async (it: { source: string; start: number; end: number }) => {
      calls.push(`${it.source}@${it.start}`)
      return it.source === 'bad' ? null : { keyframe: Math.floor(it.start / 2) * 2, end: it.end }
    }
    const res = await lookupCopyCuts(
      [
        { source: 'a', start: 13.4, end: 20 },
        { source: 'bad', start: 1, end: 2 },
        { source: 'a', start: 13.4, end: 20 },
        { source: 'a', start: 45.1, end: 50 }
      ],
      lookup
    )
    expect(res).toEqual([{ keyframe: 12, end: 20 }, null, { keyframe: 12, end: 20 }, { keyframe: 44, end: 50 }])
    expect(calls.sort()).toEqual(['a@13.4', 'a@45.1', 'bad@1'])
  })

  it('never runs more than 4 probes at once; a rejected probe becomes null', async () => {
    let running = 0
    let peak = 0
    const probe = async (f: string): Promise<number | null> => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      if (f === 'boom') throw new Error('x')
      return f.length
    }
    const files = ['a', 'bb', 'boom', 'dddd', 'eeeee', 'ffffff', 'g']
    expect(await measureMediaEnds(files, probe)).toEqual([1, 2, null, 4, 5, 6, 1])
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('stops starting new probes once aborted', async () => {
    const ac = new AbortController()
    let calls = 0
    const res = await lookupCopyCuts(
      Array.from({ length: 10 }, (_, i) => ({ source: 's', start: i, end: i + 1 })),
      async () => {
        calls++
        ac.abort()
        return { keyframe: 0, end: 1 }
      },
      ac.signal
    )
    expect(calls).toBeLessThanOrEqual(4)
    expect(res.filter((v) => v === null).length).toBeGreaterThanOrEqual(6)
  })

  it('a missing ffprobe executable yields null instead of throwing', async () => {
    const lookup = createCutLookup(path.join(__dirname, 'no-such-ffprobe.exe'))
    expect(await lookup({ source: 'x.mp4', start: 1, end: 2 })).toBeNull()
  })
})

describe('defaultFfprobePath', () => {
  it('ADITOR_FFPROBE wins, then ffprobe next to ADITOR_FFMPEG, then PATH', () => {
    expect(defaultFfprobePath({ ADITOR_FFPROBE: 'X:/p.exe', ADITOR_FFMPEG: 'X:/bin/ffmpeg.exe' }, () => true)).toBe('X:/p.exe')
    expect(defaultFfprobePath({ ADITOR_FFMPEG: 'X:/bin/ffmpeg.exe' }, () => true)).toBe(path.join('X:/bin', 'ffprobe.exe'))
    expect(defaultFfprobePath({ ADITOR_FFMPEG: 'X:/bin/ffmpeg.exe' }, () => false)).toBe('ffprobe')
    expect(defaultFfprobePath({}, () => true)).toBe('ffprobe')
  })
})
