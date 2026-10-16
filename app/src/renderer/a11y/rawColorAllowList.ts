// 唯一的「允許出現色碼字面值」清單（noRawColors.test.ts 使用）。
// 設計規則：TSX／TS 內不得寫 #hex／rgb()／rgba()／hsl() 字面值，顏色一律來自 tokens.css 的 CSS 變數
// （canvas 主題由 timeline/draw.ts 的 readTheme 於執行期從 CSS 變數讀出）。
// 若真的需要例外，在此新增 { file, reason }；清單內的檔案必須確實含有色碼（否則視為過期條目，測試失敗）。
export interface RawColorException {
  /** 相對 app/src/renderer 的路徑，使用 / */
  file: string
  reason: string
}

export const RAW_COLOR_ALLOWLIST: readonly RawColorException[] = []
