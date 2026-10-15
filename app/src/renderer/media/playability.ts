import { VideoInfo } from '../../shared/types'

const SUPPORTED_CONTAINERS = new Set(['mp4', 'mov', 'webm'])
const SUPPORTED_CODECS = new Set(['h264', 'avc1', 'hevc', 'h265', 'vp9', 'av1', 'av01'])

export function containerCodecSupported(info: VideoInfo, container: string): boolean {
  const cont = container.replace(/^\./, '').toLowerCase()
  if (!SUPPORTED_CONTAINERS.has(cont)) {
    return false
  }

  const cod = (info.codec || '').toLowerCase()
  return SUPPORTED_CODECS.has(cod)
}

export interface PlayabilityResult {
  supported: boolean
  smooth: boolean
  powerEfficient: boolean
}

export async function checkSmooth(info: VideoInfo): Promise<PlayabilityResult> {
  if (typeof navigator !== 'undefined' && navigator.mediaCapabilities?.decodingInfo) {
    try {
      const mime = info.codec.toLowerCase().includes('av1')
        ? 'video/mp4; codecs="av01.0.08M.10"'
        : info.codec.toLowerCase().includes('vp9')
        ? 'video/webm; codecs="vp9"'
        : 'video/mp4; codecs="avc1.640028"'

      const res = await navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        video: {
          contentType: mime,
          width: info.width || 1920,
          height: info.height || 1080,
          bitrate: 10000000,
          framerate: 60
        }
      })
      return {
        supported: res.supported,
        smooth: res.smooth,
        powerEfficient: res.powerEfficient
      }
    } catch {
      // Fallback
    }
  }

  return {
    supported: true,
    smooth: true,
    powerEfficient: true
  }
}

export function shouldSuggestProxy(r: PlayabilityResult): boolean {
  return !r.supported || !r.smooth || !r.powerEfficient
}
