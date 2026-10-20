import { concatCompatible, type StreamProbe } from './exportCompat'

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
 * Timeline spec for mixed sources: like an NLE timeline, use a canvas as wide as the widest source and as tall as the tallest,
 * plus the highest frame rate, so no source is downscaled or has frames dropped (independent of source order);
 * smaller sources are upscaled with a high-quality scaler instead.
 */
export function timelineSpec(probes: ReadonlyArray<StreamProbe | undefined>): VideoSpec {
  const known = probes.filter((p): p is StreamProbe => !!p)
  const sized = known.filter((p) => p.width > 0 && p.height > 0)
  const fps = Math.max(0, ...known.map((p) => (p.fps > 0 ? p.fps : 0)))
  return {
    width: sized.length ? even(Math.max(...sized.map((p) => p.width))) : FALLBACK_SPEC.width,
    height: sized.length ? even(Math.max(...sized.map((p) => p.height))) : FALLBACK_SPEC.height,
    fps: fps > 0 ? fps : FALLBACK_SPEC.fps
  }
}

/** Peak video bitrate used by both encoder rate control and disk-space estimates. */
export function peakBitrateKbps(spec: VideoSpec): number {
  return Math.round(targetBitrateKbps(spec) * 1.5)
}

/** Use the first source spec when streams already match; otherwise render to a common timeline. */
export function concatRenderSpec(probes: ReadonlyArray<StreamProbe | undefined>): { spec: VideoSpec; normalize: boolean } {
  const known = probes.filter((p): p is StreamProbe => !!p)
  const normalize = probes.length > 1 && (known.length < probes.length || !concatCompatible(known).ok)
  return { spec: normalize ? timelineSpec(probes) : sourceSpec(probes[0]), normalize }
}
