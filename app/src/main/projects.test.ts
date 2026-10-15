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
    // 檔案確實落在 <id>.json
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
    // 暫存檔已清除
    expect(fs.existsSync(path.join(dir, 'p_atomic.json.tmp'))).toBe(false)
  })

  test('corrupt project file is renamed to .bak.json and load returns null', async () => {
    const { dir, store } = tmpStore()
    fs.writeFileSync(path.join(dir, 'p_bad.json'), '{oops not json', 'utf-8')

    const loaded = await store.load('p_bad')
    expect(loaded).toBeNull()
    expect(store.lastError).toContain('損毀')
    expect(fs.existsSync(path.join(dir, 'p_bad.json'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'p_bad.bak.json'))).toBe(true)

    // 不存在的 id → null（不建備份）
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
})
