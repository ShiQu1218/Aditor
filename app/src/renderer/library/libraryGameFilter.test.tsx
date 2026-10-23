// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LibraryScreen } from './LibraryScreen'
import type { LibraryEntry } from '../../main/library'
import { GAMES, type GameId } from '../../shared/games'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { cleanupMounted, click, flush, installDomShims, mount } from '../../../test/dom'
import { i18n } from '../i18n'

const apex: LibraryEntry = {
  source: 'recording',
  path: 'D:/rec/apex.mp4',
  addedAt: Date.now(),
  favorite: false,
  status: 'done',
  progress: 1,
  game: 'apex'
}
const valorant: LibraryEntry = {
  source: 'external',
  path: 'D:/rec/valorant.mp4',
  addedAt: Date.now() - 1000,
  favorite: false,
  status: 'done',
  progress: 1,
  game: 'valorant'
}
/** Completed before multi-game support: belongs to Apex. */
const legacy: LibraryEntry = {
  path: 'D:/rec/legacy.mp4',
  addedAt: Date.now() - 2000,
  favorite: false,
  status: 'done',
  progress: 1
}

let fake: FakeApi
let restore: () => void

beforeEach(async () => {
  installDomShims()
  fake = createFakeApi({ entries: [apex, valorant, legacy] })
  restore = installFakeApi(fake)
})

afterEach(() => {
  cleanupMounted()
  restore()
  vi.restoreAllMocks()
})

async function setup(): Promise<HTMLElement> {
  const { container } = mount(
    <Providers>
      <LibraryScreen onSelectVideo={() => undefined} onOpenSettings={() => undefined} />
    </Providers>
  )
  await flush()
  return container
}

function cardPaths(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.vcard')).map((card) => card.dataset.vcardPath ?? '')
}

function gameGroup(root: ParentNode): HTMLElement {
  return root.querySelector<HTMLElement>(`[role="group"][aria-label="${i18n.library.gameFilter}"]`)!
}

function gameChip(root: ParentNode, game: GameId): HTMLButtonElement {
  const chip = Array.from(gameGroup(root).querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    (button.textContent ?? '').includes(GAMES[game].displayName)
  )
  if (!chip) throw new Error(`missing chip for ${game}`)
  return chip
}

describe('library game filter', () => {
  test('source chips count and filter recordings, imports and legacy entries', async () => {
    const container = await setup()
    const chip = (label: string): HTMLButtonElement =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('.lib-chip')).find((button) =>
        (button.textContent ?? '').startsWith(label)
      )!
    const recording = chip(i18n.library.chips.recording)
    const external = chip(i18n.library.chips.external)

    expect(recording.querySelector('.n')?.textContent).toBe('1')
    expect(external.querySelector('.n')?.textContent).toBe('2')
    click(recording)
    expect(recording.getAttribute('aria-pressed')).toBe('true')
    expect(cardPaths(container)).toEqual([apex.path])
    click(external)
    expect(recording.getAttribute('aria-pressed')).toBe('false')
    expect(external.getAttribute('aria-pressed')).toBe('true')
    expect(cardPaths(container)).toEqual([valorant.path, legacy.path])
    click(gameChip(container, 'apex'))
    expect(cardPaths(container)).toEqual([legacy.path])
    click(chip(i18n.library.chips.all))
    expect(cardPaths(container)).toHaveLength(3)
    expect(external.getAttribute('aria-pressed')).toBe('false')
  })

  test('game chips show counts, filter the grid, and toggle back to all', async () => {
    const container = await setup()

    expect(gameChip(container, 'apex').querySelector('.n')?.textContent).toBe('2')
    expect(gameChip(container, 'valorant').querySelector('.n')?.textContent).toBe('1')
    expect(gameChip(container, 'valorant').getAttribute('aria-pressed')).toBe('false')
    expect(cardPaths(container)).toHaveLength(3)

    click(gameChip(container, 'valorant'))
    expect(gameChip(container, 'valorant').getAttribute('aria-pressed')).toBe('true')
    expect(cardPaths(container)).toEqual([valorant.path])

    click(gameChip(container, 'valorant'))
    expect(gameChip(container, 'valorant').getAttribute('aria-pressed')).toBe('false')
    expect(cardPaths(container)).toHaveLength(3)
  })

  test('the All chip resets the game filter', async () => {
    const container = await setup()
    click(gameChip(container, 'valorant'))
    expect(cardPaths(container)).toEqual([valorant.path])

    const allChip = Array.from(container.querySelectorAll<HTMLButtonElement>('.lib-chip')).find((button) =>
      (button.textContent ?? '').startsWith(i18n.library.chips.all)
    )!
    click(allChip)
    expect(cardPaths(container)).toHaveLength(3)
  })

  test('cards show their game tag', async () => {
    const container = await setup()

    const valorantCard = container.querySelector<HTMLElement>(`[data-vcard-path="${valorant.path}"]`)!
    expect(valorantCard.querySelector('.vcard-game')?.textContent).toBe(GAMES.valorant.displayName)
    expect(valorantCard.querySelector('.vcard-game')?.classList.contains('valorant')).toBe(true)

    // Legacy completed entries are tagged Apex.
    const legacyCard = container.querySelector<HTMLElement>(`[data-vcard-path="${legacy.path}"]`)!
    expect(legacyCard.querySelector('.vcard-game')?.textContent).toBe(GAMES.apex.displayName)
    expect(legacyCard.querySelector('.vcard-game')?.classList.contains('apex')).toBe(true)
  })
})
