import { describe, it, expect } from 'vitest'
import { History } from './history'

describe('History stack manager', () => {
  it('manages undo and redo correctly', () => {
    const hist = new History<number>(1)
    expect(hist.current).toBe(1)
    expect(hist.canUndo).toBe(false)
    expect(hist.canRedo).toBe(false)

    hist.push(2)
    hist.push(3)
    expect(hist.current).toBe(3)
    expect(hist.canUndo).toBe(true)
    expect(hist.canRedo).toBe(false)

    expect(hist.undo()).toBe(2)
    expect(hist.current).toBe(2)
    expect(hist.canUndo).toBe(true)
    expect(hist.canRedo).toBe(true)

    expect(hist.undo()).toBe(1)
    expect(hist.current).toBe(1)
    expect(hist.canUndo).toBe(false)
    expect(hist.canRedo).toBe(true)

    expect(hist.redo()).toBe(2)
    expect(hist.current).toBe(2)
  })

  it('push clears redo stack', () => {
    const hist = new History<string>('a')
    hist.push('b')
    hist.push('c')
    hist.undo() // at 'b', redo has 'c'
    expect(hist.canRedo).toBe(true)

    hist.push('d') // new branch
    expect(hist.current).toBe('d')
    expect(hist.canRedo).toBe(false)
  })

  it('respects history limit', () => {
    const hist = new History<number>(0, 3) // max 3 past entries
    hist.push(1)
    hist.push(2)
    hist.push(3)
    hist.push(4) // past should drop 0

    expect(hist.current).toBe(4)
    expect(hist.undo()).toBe(3)
    expect(hist.undo()).toBe(2)
    expect(hist.undo()).toBe(1)
    expect(hist.canUndo).toBe(false) // cannot undo back to 0
  })
})
