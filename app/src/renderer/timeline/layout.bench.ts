// Performance benchmark (vitest bench; not a CI failure threshold; results are recorded in docs/superpowers/plans/EXECUTION-NOTES.md).
// Run with: npm --prefix app run bench
import { describe, test } from 'vitest'
import type { EventType } from '../../shared/types'
import { genLong } from '../../../test/fixtures/genEvents'
import { CARD, cardRowHeight, computeGrid } from '../lib/gridLayout'
import { layoutTimeline } from './layout'
import type { View } from './model'

const ALL = new Set<EventType>(['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe'])

for (const n of [2000, 6000]) {
  const { events, duration } = genLong(n - 300)
  const full: View = { duration, start: 0, span: duration, width: 1400 }
  const zoomed: View = { duration, start: duration / 3, span: duration / 24, width: 1400 }
  describe(`layoutTimeline ${events.length} events`, () => {
    test('view modes', async ({ bench }) => {
      await bench.compare(
        bench('full view (density mode)', () => {
          layoutTimeline(events, full, ALL)
        }),
        bench('zoomed view (icons + clusters)', () => {
          layoutTimeline(events, zoomed, ALL)
        })
      )
    })
  })
}

describe('library computeGrid 500 entries', () => {
  const groups = [60, 140, 100, 120, 80]
  const rowHeight = cardRowHeight(CARD.min)
  test('scroll positions', async ({ bench }) => {
    await bench.compare(
      bench('scrollTop 0', () => {
        computeGrid({ width: 1286, cardMin: CARD.min, gap: CARD.gap, rowHeight, headerHeight: CARD.headerH, groups, scrollTop: 0, viewHeight: 700, overscanRows: CARD.overscanRows })
      }),
      bench('scrollTop mid-list', () => {
        computeGrid({ width: 1286, cardMin: CARD.min, gap: CARD.gap, rowHeight, headerHeight: CARD.headerH, groups, scrollTop: 20000, viewHeight: 700, overscanRows: CARD.overscanRows })
      })
    )
  })
})
