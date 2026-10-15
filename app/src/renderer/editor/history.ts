export class History<T> {
  private past: T[] = []
  private present: T
  private future: T[] = []
  private limit: number

  constructor(initial: T, limit = 100) {
    this.present = initial
    this.limit = limit
  }

  get current(): T {
    return this.present
  }

  push(next: T): void {
    this.past.push(this.present)
    if (this.past.length > this.limit) {
      this.past.shift()
    }
    this.present = next
    this.future = []
  }

  undo(): T {
    if (!this.canUndo) return this.present
    this.future.unshift(this.present)
    this.present = this.past.pop()!
    return this.present
  }

  redo(): T {
    if (!this.canRedo) return this.present
    this.past.push(this.present)
    this.present = this.future.shift()!
    return this.present
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }
}
