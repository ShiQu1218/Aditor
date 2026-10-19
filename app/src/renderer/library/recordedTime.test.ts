import { describe, expect, test } from 'vitest'
import { recordedTime, studioVideoTitle } from './recordedTime'
import { thumbnailUrl, cardStatusText } from './cardLogic'
import { i18n } from '../i18n'

const addedAt = new Date(2026, 9, 20, 12).getTime()
const entry = (path: string) => ({ path, addedAt })

describe('Recording time and studio title', () => {
  test.each(['D:/錄影/Apex_2026-10-18_23-59.mp4', 'D:\\錄影\\Apex_2026-10-18_23-59_2.mp4'])('Parses recording filenames in local time: %s', (path) => {
    expect(recordedTime(entry(path))).toBe(new Date(2026, 9, 18, 23, 59).getTime())
    expect(studioVideoTitle(path)).toBe('23:59')
  })
  test.each(['比賽重播.webm', 'Other_Apex_2026-10-18_12-00.mp4', 'Apex_2026-10-18_12-00-00.mp4',
    'Apex_2026-02-29_12-00.mp4', 'Apex_2026-04-31_12-00_2.mp4', 'Apex_2026-13-18_12-00.mp4',
    'Apex_2026-10-00_12-00.mp4', 'Apex_2026-10-18_24-00.mp4', 'Apex_2026-10-18_12-60.mp4'])('Falls back to addedAt for non-recording files or invalid dates: %s', (path) => {
    expect(recordedTime(entry(path))).toBe(addedAt)
    expect(studioVideoTitle(path)).toBe(path.replace(/\.[^.]+$/, ''))
  })
  test('Leap-year dates are valid', () => {
    expect(recordedTime(entry('Apex_2024-02-29_00-00.mp4'))).toBe(new Date(2024, 1, 29).getTime())
  })
})

describe('Shared card display logic', () => {
  test('Thumbnail URL encodes Chinese, spaces, reserved characters, and percent signs', () => {
    expect(thumbnailUrl('C:\\縮圖\\一場 #1? 50%.jpg')).toBe('file://C:/%E7%B8%AE%E5%9C%96/%E4%B8%80%E5%A0%B4%20%231%3F%2050%25.jpg')
  })
  test('Pending status distinguishes not queued from waiting in the queue', () => {
    expect(cardStatusText({ status: 'pending' }, 'idle')).toBe('尚未分析')
    expect(cardStatusText({ status: 'pending' }, 'queued')).toBe(i18n.library.card.waiting)
    expect(cardStatusText({ status: 'analyzing' }, 'analyzing')).toBe(i18n.library.card.analyzing)
    expect(cardStatusText({ status: 'error' }, 'idle')).toBe(i18n.library.card.error)
    expect(cardStatusText({ status: 'done' }, 'idle')).toBe('')
  })
})
