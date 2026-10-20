import type { StreamProbe } from '../../shared/exportCompat'

/** Output video spec for a precise export (the "timeline" every segment is rendered to). */
export interface VideoSpec {
  width: number
  height: number
  fps: number
}

export const FALLBACK_SPEC: VideoSpec = { width: 1920, height: 1080, fps: 60 }

/**
 * Bits per pixel per frame for the target bitrate: 0.2 gives about 25 Mbps at 1080p60, in line with
 * NLE "automatic best" H.264 renders, and keeps fast-moving game footage free of blocking.
 */
const BITS_PER_PIXEL = 0.2
const MIN_KBPS = 8_000
const MAX_KBPS = 150_000
const PEAK_RATIO = 1.5
const BUFFER_RATIO = 2
/** NVENC constant-quality level (lower is better; 19 is visually transparent for most game captures). */
const NVENC_CQ = '19'

const even = (v: number): number => Math.max(2, Math.floor(v / 2) * 2)

/** Target average bitrate in kbps for the spec, rounded to 100 kbps and clamped to a sane range. */
export function targetBitrateKbps(spec: VideoSpec): number {
  const kbps = Math.round((spec.width * spec.height * spec.fps * BITS_PER_PIXEL) / 100_000) * 100
  return Math.min(MAX_KBPS, Math.max(MIN_KBPS, kbps))
}

/** Spec of a single source, falling back per field when the probe is missing or incomplete. */
export function sourceSpec(probe: StreamProbe | undefined): VideoSpec {
  return timelineSpec([probe])
}

/**
 * Timeline spec for mixed sources: like an NLE timeline, pick the largest resolution and the highest frame rate
 * so no source is downscaled or has frames dropped; smaller sources are upscaled with a high-quality scaler instead.
 */
export function timelineSpec(probes: ReadonlyArray<StreamProbe | undefined>): VideoSpec {
  const known = probes.filter((p): p is StreamProbe => !!p)
  const sized = known.filter((p) => p.width > 0 && p.height > 0)
  const largest = sized.reduce<StreamProbe | null>((best, p) => (!best || p.width * p.height > best.width * best.height ? p : best), null)
  const fps = Math.max(0, ...known.map((p) => (p.fps > 0 ? p.fps : 0)))
  return {
    width: largest ? even(largest.width) : FALLBACK_SPEC.width,
    height: largest ? even(largest.height) : FALLBACK_SPEC.height,
    fps: fps > 0 ? fps : FALLBACK_SPEC.fps
  }
}

/**
 * Video encoder arguments with explicit rate control. Without them, hardware encoders fall back to very low
 * defaults (NVENC encodes at about 2 Mbps), which makes precise exports look blurry.
 */
export function videoEncodeArgs(encoder: string, spec: VideoSpec): string[] {
  const kbps = targetBitrateKbps(spec)
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * PEAK_RATIO)}k`, '-bufsize', `${kbps * BUFFER_RATIO}k`]
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', encoder, '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', NVENC_CQ, ...rate, '-spatial-aq', '1', '-profile:v', 'high']
    case 'h264_qsv':
      return ['-c:v', encoder, '-preset', 'slow', ...rate, '-profile:v', 'high']
    case 'h264_amf':
      return ['-c:v', encoder, '-quality', 'quality', '-rc', 'vbr_peak', ...rate, '-profile:v', 'high']
    case 'libopenh264':
      return ['-c:v', encoder, ...rate, '-allow_skip_frames', '0']
    default:
      return ['-c:v', encoder, ...rate]
  }
}
