import { test, expect, card } from './helpers/test'

test('native file drops import and analyze videos in both empty and populated libraries', async ({ launch, videos }) => {
  const { page } = await launch()
  const session = await page.context().newCDPSession(page)
  try {
    // CDP 從磁碟建立原生 File；new File() 沒有本機路徑，無法驗證 preload 的路徑解析。
    for (const batch of [videos.videos.slice(0, 2), videos.videos.slice(2)]) {
      const box = (await page.locator('.lib-screen').boundingBox())!
      const data = { items: [], files: batch.map((video) => video.path), dragOperationsMask: 1 }
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data })
      await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data })
      await expect(page.locator('.drop-overlay')).toBeVisible()
      await session.send('Input.dispatchDragEvent', { type: 'drop', ...point, data })
      await expect(page.locator('.drop-overlay')).toHaveCount(0)
      for (const video of batch) await expect(card(page, video.title).locator('.vcard-counts')).toBeVisible()
    }
    await expect(page.locator('.vcard')).toHaveCount(3)
  } finally {
    await session.detach()
  }
})

test('a File created in JavaScript has no disk path and is ignored', async ({ launch }) => {
  const { page } = await launch()
  const url = page.url()
  await page.locator('.lib-screen').evaluate((element) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['video'], 'virtual.mp4', { type: 'video/mp4' }))
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  })
  const entries = await page.evaluate(() => window.api.library.getEntries())
  expect(entries).toEqual([])
  await expect(page.locator('.lib-empty')).toBeVisible()
  expect(page.url()).toBe(url)
})
