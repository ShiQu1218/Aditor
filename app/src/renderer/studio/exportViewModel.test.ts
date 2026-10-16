import { describe, expect, test } from 'vitest'
import { exportViewModel, ExportPlan } from './exportViewModel'
import { Project } from '../editor/project'
import { i18n } from '../i18n/zh-TW'

const A = 'D:/v/a.mp4'
const B = 'D:/v/b.mp4'

function proj(items: Array<[string, string, number, number]>): Project {
  return { version: 1, name: 'p', items: items.map(([id, source, start, end]) => ({ id, source, start, end })) }
}

function plan(over: Partial<ExportPlan> = {}): ExportPlan {
  return {
    mode: 'concat',
    quality: 'copy',
    sources: { [A]: { codec: 'h264', width: 1920, height: 1080 }, [B]: { codec: 'h264', width: 1920, height: 1080 } },
    keyframes: {},
    missingItemIds: new Set<string>(),
    ...over
  }
}

const HW = { encoders: ['h264_nvenc'], openh264: false }

describe('exportViewModel', () => {
  test('mixed source params → copyAvailable false with fallback notice', () => {
    const p = proj([['1', A, 0, 10], ['2', B, 5, 15]])
    const vm = exportViewModel(p, plan({ sources: { [A]: { codec: 'h264', width: 1920, height: 1080 }, [B]: { codec: 'h264', width: 1728, height: 1080 } } }), HW)
    expect(vm.copyAvailable).toBe(false)
    expect(vm.notices.some((n) => n.text.includes(i18n.export.fallbackReencodeNotice))).toBe(true)
    expect(vm.effectiveQuality).toBe('precise')
    expect(vm.extraSecondsHint).toBeNull()
  })

  test('concat: one source repeated keeps copy; two sources with unconfirmable fps/audio fall back to precise (I9); separate is always copy-capable', () => {
    const same = proj([['1', A, 0, 10], ['2', A, 20, 30]])
    expect(exportViewModel(same, plan(), HW).copyAvailable).toBe(true)
    const p = proj([['1', A, 0, 10], ['2', B, 5, 15]])
    expect(exportViewModel(p, plan(), HW).copyAvailable).toBe(false)
    const mixed = plan({ mode: 'separate', sources: { [A]: { codec: 'h264', width: 1, height: 1 }, [B]: { codec: 'hevc', width: 2, height: 2 } } })
    expect(exportViewModel(p, mixed, HW).copyAvailable).toBe(true)
  })

  test('missing source files become blockers and disable start', () => {
    const p = proj([['1', A, 0, 10], ['2', B, 5, 15]])
    const vm = exportViewModel(p, plan({ missingItemIds: new Set(['2']) }), HW)
    expect(vm.canStart).toBe(false)
    expect(vm.blockers.some((b) => b.includes(B))).toBe(true)
    expect(vm.blockers.some((b) => b.includes(A))).toBe(false)
  })

  test('empty project cannot start', () => {
    const vm = exportViewModel(proj([]), plan(), HW)
    expect(vm.canStart).toBe(false)
    expect(vm.blockers).toContain(i18n.export.blockEmpty)
  })

  test('null plan cannot start', () => {
    expect(exportViewModel(proj([['1', A, 0, 10]]), null, HW).canStart).toBe(false)
  })

  test('extraSecondsHint uses keyframe gaps for copy mode only', () => {
    const p = proj([['1', A, 10, 20], ['2', A, 31, 40]])
    const kf = { [A]: [0, 8, 30] } // 10-8=2, 31-30=1 → 平均 1.5
    const copy = exportViewModel(p, plan({ quality: 'copy', keyframes: kf }), HW)
    expect(copy.extraSecondsHint).toBeCloseTo(1.5, 5)
    const precise = exportViewModel(p, plan({ quality: 'precise', keyframes: kf }), HW)
    expect(precise.extraSecondsHint).toBeNull()
  })

  test('extraSecondsHint is null when no keyframes are known (no invented number)', () => {
    const p = proj([['1', A, 10, 20]])
    expect(exportViewModel(p, plan({ quality: 'copy', keyframes: {} }), HW).extraSecondsHint).toBeNull()
  })

  test('openh264 required when no hw encoders and not installed', () => {
    const p = proj([['1', A, 0, 10]])
    const vm = exportViewModel(p, plan({ quality: 'precise' }), { encoders: [], openh264: false })
    expect(vm.openh264Required).toBe(true)
    expect(vm.canStart).toBe(false)
    // 快速無損不需要編碼器
    const copy = exportViewModel(p, plan({ quality: 'copy', mode: 'separate' }), { encoders: [], openh264: false })
    expect(copy.openh264Required).toBe(false)
    expect(copy.canStart).toBe(true)
    // 有硬體編碼器或已安裝都不需要
    expect(exportViewModel(p, plan({ quality: 'precise' }), HW).openh264Required).toBe(false)
    expect(exportViewModel(p, plan({ quality: 'precise' }), { encoders: ['libopenh264'], openh264: true }).openh264Required).toBe(false)
  })

  test('mixed params fallback in concat requires an encoder too', () => {
    const p = proj([['1', A, 0, 10], ['2', B, 0, 10]])
    const mixed = plan({ sources: { [A]: { codec: 'h264', width: 1, height: 1 }, [B]: { codec: 'h264', width: 2, height: 2 } } })
    expect(exportViewModel(p, mixed, { encoders: [], openh264: false }).openh264Required).toBe(true)
    expect(exportViewModel(p, mixed, HW).canStart).toBe(true)
  })
})
