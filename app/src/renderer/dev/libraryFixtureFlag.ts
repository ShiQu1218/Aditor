/**
 * 僅開發模式：URL 帶 ?fixture=library500 時，以合成的 500 筆影片庫資料取代真實資料。
 * 旗標與資料分檔：這個檔很小、可靜態匯入；資料檔 libraryFixture.ts 只經 `import()` 載入，
 * 且呼叫端都在 library500Requested()（含 import.meta.env.DEV）之內，所以正式包的 dead-code 會被剪掉。
 */
export function library500Requested(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('fixture') === 'library500'
}
