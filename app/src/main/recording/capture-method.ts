import os from 'os'
import type { RecordingCaptureMethod } from '../../shared/recording'

/** WGC can hide its yellow capture border (IsBorderRequired) only from this Windows build; Windows 10 always draws it. */
const BORDERLESS_CAPTURE_MIN_BUILD = 20348

/** Whether window capture can run without the yellow border; unknown releases and other platforms assume it can. */
export function supportsBorderlessCapture(release: string = os.release(), platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return true
  const build = Number(release.split('.')[2])
  return !Number.isFinite(build) || build >= BORDERLESS_CAPTURE_MIN_BUILD
}

/** `auto` uses screen capture (DDA) where window capture (WGC) would show the yellow border, and WGC elsewhere. */
export function resolveCaptureMethod(method: RecordingCaptureMethod, borderless: boolean = supportsBorderlessCapture()): 'wgc' | 'dda' {
  if (method !== 'auto') return method
  return borderless ? 'wgc' : 'dda'
}
