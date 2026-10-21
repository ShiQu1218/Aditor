import path from 'path'
import { describe, expect, it } from 'vitest'
import { gameOf, gameProfileDir, gameSceneDir } from './games'
import { countEvents, type EngineEvent } from './types'
import { gameMetadataArgs, outputBase } from '../main/recording/finalize'
import { recordedTime } from '../renderer/library/recordedTime'

describe('game registry', () => {
  it('treats missing or unknown games as Apex for older data', () => {
    expect(gameOf(undefined)).toBe('apex')
    expect(gameOf('csgo')).toBe('apex')
    expect(gameOf('valorant')).toBe('valorant')
  })

  it('keeps Apex templates at the top level and nests other games', () => {
    const icons = path.join('res', 'templates', 'icons')
    expect(gameProfileDir(icons, 'apex')).toBe(icons)
    expect(gameSceneDir(icons, 'apex')).toBe(path.join('res', 'templates', 'scene'))
    expect(gameProfileDir(icons, 'valorant')).toBe(path.join('res', 'templates', 'valorant', 'icons'))
    expect(gameSceneDir(icons, 'valorant')).toBe(path.join('res', 'templates', 'valorant', 'scene'))
  })
})

describe('game-aware recording output', () => {
  const at = new Date(2026, 9, 20, 21, 8).getTime()

  it('names recordings after the game and parses both back to their recording time', () => {
    expect(outputBase(at)).toBe('Apex_2026-10-20_21-08')
    expect(outputBase(at, 'valorant')).toBe('Valorant_2026-10-20_21-08')
    expect(recordedTime({ path: `D:/v/${outputBase(at, 'valorant')}_2.mp4`, addedAt: 0 })).toBe(at)
  })

  it('tags only non-Apex games so Apex output stays as before', () => {
    expect(gameMetadataArgs({ game: 'apex' })).toEqual(['-movflags', '+faststart'])
    expect(gameMetadataArgs({ gameAspect: '1920x1440', game: 'apex' }))
      .toEqual(['-metadata', 'aditor_game_aspect=1920x1440', '-movflags', '+faststart+use_metadata_tags'])
    expect(gameMetadataArgs({ game: 'valorant' }))
      .toEqual(['-metadata', 'aditor_game=valorant', '-movflags', '+faststart+use_metadata_tags'])
  })
})


describe('Valorant event counts', () => {
  const ev = (type: string, counted: boolean, deleted = false): EngineEvent => ({ id: type + String(counted) + String(deleted), t: 1, type,
    score: 1, damage_line: false, name_sig: null, counted, counted_reason: '', counted_override: null, source: 'auto', deleted })

  it('tallies deaths apart from kills, so two kills and a death are two kills', () => {
    expect(countEvents([ev('kill', true), ev('kill', true), ev('death', false)])).toEqual({ knock: 0, assist: 0, kill: 2, death: 1 })
    expect(countEvents([ev('death', false, true)])).toEqual({ knock: 0, assist: 0 })
  })
})
