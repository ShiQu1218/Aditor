import { tr } from './locale'
/** Export compatibility checks (pure functions shared by main plan.ts and the renderer's export drawer). */

export interface StreamProbe {
  vcodec: string
  width: number
  height: number
  fps: number
  pix_fmt: string
  acodec: string
  sample_rate: number
  channels: number
}

export function extraSecondsForCopy(start: number, keyframes: number[]): number {
  if (!keyframes || keyframes.length === 0) {
    return Math.round(start * 1000) / 1000
  }

  let priorKf = -1
  for (const kf of keyframes) {
    if (kf <= start) {
      if (kf > priorKf) {
        priorKf = kf
      }
    }
  }

  if (priorKf === -1) {
    return Math.round(start * 1000) / 1000
  }

  const extra = start - priorKf
  return Math.round(extra * 1000) / 1000
}

export function concatCompatible(probes: StreamProbe[]): { ok: boolean; reason?: string } {
  if (probes.length <= 1) {
    return { ok: true }
  }

  // The engine probe currently provides only codec/resolution; when frame rate, pixel format, or audio specs are unknown (0/empty), compatibility cannot be proven, so treat it conservatively as incompatible.
  if (probes.some((p) => !(p.fps > 0) || !p.pix_fmt || !p.acodec || !(p.sample_rate > 0) || !(p.channels > 0))) {
    return { ok: false, reason: tr('無法確認幀率、像素格式或音訊規格是否一致') }
  }

  const first = probes[0]
  for (let i = 1; i < probes.length; i++) {
    const p = probes[i]
    if (p.vcodec !== first.vcodec) {
      return { ok: false, reason: tr('視訊編碼不同: {vcodec} vs {vcodec2}', { vcodec: first.vcodec, vcodec2: p.vcodec }) }
    }
    if (p.width !== first.width || p.height !== first.height) {
      return { ok: false, reason: tr('解析度不同: {width}x{height} vs {width2}x{height2}', { width: first.width, height: first.height, width2: p.width, height2: p.height }) }
    }
    if (Math.abs(p.fps - first.fps) > 0.5) {
      return { ok: false, reason: tr('幀率不同: {fps} vs {fps2}', { fps: first.fps, fps2: p.fps }) }
    }
    if (p.pix_fmt !== first.pix_fmt) {
      return { ok: false, reason: tr('像素格式不同: {pix_fmt} vs {pix_fmt2}', { pix_fmt: first.pix_fmt, pix_fmt2: p.pix_fmt }) }
    }
    if (p.acodec !== first.acodec) {
      return { ok: false, reason: tr('音訊編碼不同: {acodec} vs {acodec2}', { acodec: first.acodec, acodec2: p.acodec }) }
    }
    if (p.sample_rate !== first.sample_rate) {
      return { ok: false, reason: tr('音訊取樣率不同: {sample_rate} vs {sample_rate2}', { sample_rate: first.sample_rate, sample_rate2: p.sample_rate }) }
    }
    if (p.channels !== first.channels) {
      return { ok: false, reason: tr('音訊聲道數不同: {channels} vs {channels2}', { channels: first.channels, channels2: p.channels }) }
    }
  }

  return { ok: true }
}

