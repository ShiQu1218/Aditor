import { afterEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ProjectStore, StoredProject } from './projects'

function tmpStore(): { dir: string; store: ProjectStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-projects-'))
  return { dir, store: new ProjectStore(dir) }
}

function proj(id: string, name: string, itemCount = 1): StoredProject {
  return {
    id,
    version: 1,
    name,
    items: Array.from({ length: itemCount }, (_, i) => ({
      id: `i${i}`,
      source: `C:/v/a.mp4`,
      start: i,
      end: i + 1
    }))
  }
}

function baks(dir: string, id: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.startsWith(`${id}.bak.`) && n.endsWith('.json'))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProjectStore', () => {
  test('save then load round-trips a project', async () => {
    const { dir, store } = tmpStore()
    const p = proj('p_abc123', '我的精華專案', 2)
    await store.save(p)
    const loaded = await store.load('p_abc123')
    expect(loaded).toEqual(p)
    // The file is written to <id>.json.
    expect(fs.existsSync(path.join(dir, 'p_abc123.json'))).toBe(true)
  })

  test('save is atomic: failure during rename keeps previous file', async () => {
    const { dir, store } = tmpStore()
    const p1 = proj('p_atomic', '原始名')
    await store.save(p1)

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EPERM: rename failed')
    })
    const p2 = proj('p_atomic', '新名')
    await expect(store.save(p2)).rejects.toThrow('rename failed')
    vi.restoreAllMocks()

    const loaded = await store.load('p_atomic')
    expect(loaded?.name).toBe('原始名')
    expect(store.lastError).toContain('儲存專案失敗')
    // The temporary file has been removed.
    expect(fs.existsSync(path.join(dir, 'p_atomic.json.tmp'))).toBe(false)
  })

  test('corrupt project file is renamed to a timestamped backup and load returns null', async () => {
    const { dir, store } = tmpStore()
    fs.writeFileSync(path.join(dir, 'p_bad.json'), '{oops not json', 'utf-8')

    const loaded = await store.load('p_bad')
    expect(loaded).toBeNull()
    expect(store.lastError).toContain('損毀')
    expect(fs.existsSync(path.join(dir, 'p_bad.json'))).toBe(false)
    expect(baks(dir, 'p_bad')).toHaveLength(1)

    // Missing id → null (do not create a backup).
    expect(await store.load('p_missing')).toBeNull()
  })

  test('list returns names sorted by updatedAt desc', async () => {
    const { dir, store } = tmpStore()
    await store.save(proj('p_old', '舊專案', 1))
    await store.save(proj('p_new', '新專案', 3))

    const oldFile = path.join(dir, 'p_old.json')
    const newFile = path.join(dir, 'p_new.json')
    const t1 = new Date('2026-10-01T12:00:00')
    const t2 = new Date('2026-10-02T12:00:00')
    fs.utimesSync(oldFile, t1, t1)
    fs.utimesSync(newFile, t2, t2)

    const list = await store.list()
    expect(list.map((e) => e.id)).toEqual(['p_new', 'p_old'])
    expect(list[0]).toMatchObject({ name: '新專案', items: 3 })
    expect(list[0].updatedAt).toBeGreaterThan(list[1].updatedAt)
  })

  test('remove deletes the project file and tolerates missing ids', async () => {
    const { dir, store } = tmpStore()
    await store.save(proj('p_del', '刪除我'))
    await store.remove('p_del')
    expect(fs.existsSync(path.join(dir, 'p_del.json'))).toBe(false)
    await expect(store.remove('p_del')).resolves.toBeUndefined()
  })

  test('transient read error returns null, is NOT renamed, and reports transient', async () => {
    const { dir, store } = tmpStore()
    await store.save(proj('p_busy', '忙碌'))
    const real = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((f: any, ...a: any[]) => {
      if (String(f).endsWith('p_busy.json')) throw Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' })
      return (real as any)(f, ...a)
    }) as any)
    expect(await store.load('p_busy')).toBeNull()
    expect(store.lastErrorKind).toBe('transient')
    expect(store.lastError).toContain('暫時')
    vi.restoreAllMocks()
    expect(fs.existsSync(path.join(dir, 'p_busy.json'))).toBe(true)
    expect(baks(dir, 'p_busy')).toHaveLength(0)
    expect((await store.load('p_busy'))?.name).toBe('忙碌')
  })

  test('shape errors are corrupt: renamed, existing backups never overwritten, keep newest 3', async () => {
    const { dir, store } = tmpStore()
    vi.spyOn(Date, 'now').mockReturnValue(1000) // Do not overwrite even when timestamps are in the same millisecond.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, 'p_x.json'), JSON.stringify({ version: 1, name: 'x', items: [{ id: 1 }] }), 'utf-8')
      expect(await store.load('p_x')).toBeNull()
      vi.spyOn(Date, 'now').mockReturnValue(1000 + i + 1)
    }
    const names = baks(dir, 'p_x')
    expect(names).toHaveLength(3)
    // Keep the latest three backups.
    expect(names.some((n) => n.includes('.1004.'))).toBe(true)
    expect(names.some((n) => n.includes('.1001.'))).toBe(false)
  })

  test('same-millisecond backups do not overwrite each other', async () => {
    const { dir, store } = tmpStore()
    vi.spyOn(Date, 'now').mockReturnValue(5000)
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(path.join(dir, 'p_y.json'), `{bad ${i}`, 'utf-8')
      await store.load('p_y')
    }
    expect(baks(dir, 'p_y')).toHaveLength(2)
  })

  test('newer version is reported as unsupported and left untouched', async () => {
    const { dir, store } = tmpStore()
    const body = JSON.stringify({ version: 2, name: 'future', items: [] })
    fs.writeFileSync(path.join(dir, 'p_future.json'), body, 'utf-8')
    expect(await store.load('p_future')).toBeNull()
    expect(store.lastErrorKind).toBe('unsupported')
    expect(store.lastError).toContain('unsupported version')
    expect(fs.readFileSync(path.join(dir, 'p_future.json'), 'utf-8')).toBe(body)
    expect(baks(dir, 'p_future')).toHaveLength(0)
  })

  test('save rejects invalid payloads and never creates a file', async () => {
    const { dir, store } = tmpStore()
    const bad: unknown[] = [
      { ...proj('undefined', 'n') },
      { ...proj('p_ok', 'n'), id: undefined },
      { ...proj('p_ok', 'n'), id: '' },
      { ...proj('p_ok', 'n'), id: '../evil' },
      { ...proj('p_ok', 'n'), version: 2 },
      { ...proj('p_ok', 'n'), name: 5 },
      { ...proj('p_ok', 'n'), items: 'no' },
      { ...proj('p_ok', 'n'), items: [{ id: 'a', source: 'x', start: 'a', end: 1 }] },
      null
    ]
    for (const b of bad) {
      await expect(store.save(b as StoredProject)).rejects.toThrow()
    }
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([])
  })

  test('save fsyncs the temp file before renaming', async () => {
    const { store } = tmpStore()
    const order: string[] = []
    const fsync = fs.fsyncSync
    const rename = fs.renameSync
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => (order.push('fsync'), fsync(fd)))
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => (order.push('rename'), rename(a, b)))
    await store.save(proj('p_sync', 's'))
    expect(order).toEqual(['fsync', 'rename'])
  })

  test('load rejects malformed items as corrupt', async () => {
    const { dir, store } = tmpStore()
    fs.writeFileSync(
      path.join(dir, 'p_items.json'),
      JSON.stringify({ version: 1, name: 'n', items: [{ id: 'a', source: 'x', start: 0 }] }),
      'utf-8'
    )
    expect(await store.load('p_items')).toBeNull()
    expect(baks(dir, 'p_items')).toHaveLength(1)
  })

  test('list records lastError for corrupt files and skips backups', async () => {
    const { dir, store } = tmpStore()
    await store.save(proj('p_good', 'good'))
    fs.writeFileSync(path.join(dir, 'p_junk.json'), '{{{', 'utf-8')
    fs.writeFileSync(path.join(dir, 'p_good.bak.123.json'), '{"version":1,"name":"b","items":[]}', 'utf-8')
    const list = await store.list()
    expect(list.map((e) => e.id)).toEqual(['p_good'])
    expect(store.lastError).toContain('p_junk')
    expect(fs.existsSync(path.join(dir, 'p_junk.json'))).toBe(true)
  })
})
