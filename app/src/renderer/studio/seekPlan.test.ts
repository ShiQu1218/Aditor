import { describe, expect, test } from 'vitest'
import { fileUrl, planSeek, routeTimeUpdate } from './seekPlan'

describe('fileUrl', () => {
  test('converts backslashes', () => expect(fileUrl('C:\\v\\a.mp4')).toBe('file://C:/v/a.mp4'))
})

describe('planSeek', () => {
  const a = 'file://C:/v/a.mp4'
  const b = 'file://C:/v/b.mp4'
  test('applies now only when the wanted file is already loaded', () => {
    expect(planSeek({ loadedSrc: a, wantedSrc: a })).toBe('now')
  })
  test('defers when the video element still holds another file (never set currentTime on a video about to be replaced)', () => {
    expect(planSeek({ loadedSrc: b, wantedSrc: a })).toBe('defer')
  })
  test('defers before anything has loaded', () => {
    expect(planSeek({ loadedSrc: null, wantedSrc: a })).toBe('defer')
  })
})

describe('routeTimeUpdate', () => {
  const src = 'file://C:/v/a.mp4'
  const foreign = 'file://C:/v/b.mp4'
  test('source mode: updates the source time when the source is loaded', () => {
    expect(routeTimeUpdate({ previewSrc: null, sourceSrc: src, loadedSrc: src, pending: false })).toBe('source')
  })
  test('source mode: ignores stray time updates of a foreign/old video or while a seek is pending', () => {
    expect(routeTimeUpdate({ previewSrc: null, sourceSrc: src, loadedSrc: foreign, pending: false })).toBe('ignore')
    expect(routeTimeUpdate({ previewSrc: null, sourceSrc: src, loadedSrc: src, pending: true })).toBe('ignore')
  })
  test('project mode: foreign preview time goes to preview, never to the source time', () => {
    expect(routeTimeUpdate({ previewSrc: foreign, sourceSrc: src, loadedSrc: foreign, pending: false })).toBe('preview')
  })
  test('project mode: ignores updates until the previewed file is loaded', () => {
    expect(routeTimeUpdate({ previewSrc: foreign, sourceSrc: src, loadedSrc: src, pending: false })).toBe('ignore')
  })
})
