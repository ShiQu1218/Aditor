/** 匯出相容性判斷（純函式，main 的 plan.ts 與 renderer 的匯出抽屜共用）。 */

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

  const first = probes[0]
  for (let i = 1; i < probes.length; i++) {
    const p = probes[i]
    if (p.vcodec !== first.vcodec) {
      return { ok: false, reason: `視訊編碼不同: ${first.vcodec} vs ${p.vcodec}` }
    }
    if (p.width !== first.width || p.height !== first.height) {
      return { ok: false, reason: `解析度不同: ${first.width}x${first.height} vs ${p.width}x${p.height}` }
    }
    if (Math.abs(p.fps - first.fps) > 0.5) {
      return { ok: false, reason: `幀率不同: ${first.fps} vs ${p.fps}` }
    }
    if (p.pix_fmt !== first.pix_fmt) {
      return { ok: false, reason: `像素格式不同: ${first.pix_fmt} vs ${p.pix_fmt}` }
    }
    if (p.acodec !== first.acodec) {
      return { ok: false, reason: `音訊編碼不同: ${first.acodec} vs ${p.acodec}` }
    }
    if (p.sample_rate !== first.sample_rate) {
      return { ok: false, reason: `音訊取樣率不同: ${first.sample_rate} vs ${p.sample_rate}` }
    }
    if (p.channels !== first.channels) {
      return { ok: false, reason: `音訊聲道數不同: ${first.channels} vs ${p.channels}` }
    }
  }

  return { ok: true }
}

