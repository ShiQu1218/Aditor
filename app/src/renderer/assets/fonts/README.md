# 內建字型

僅 Latin 子集（U+0000-00FF 等，unicode-range 見 `../../styles/fonts.css`），格式 woff2，合計約 83 KB（測試限制 < 200 KB）。
中文不打包，由 `tokens.css` 字型堆疊的系統字型（Noto Sans TC／微軟正黑體）接手。

| 檔案 | 來源套件 | 版本 | 授權 |
| --- | --- | --- | --- |
| lato-latin-400-normal.woff2、lato-latin-700-normal.woff2 | `@fontsource/lato`（devDependency，`app/node_modules/@fontsource/lato/files/`） | 5.3.0 | SIL OFL 1.1 |
| montserrat-latin-700-normal.woff2、montserrat-latin-900-normal.woff2 | `@fontsource/montserrat`（devDependency，`app/node_modules/@fontsource/montserrat/files/`） | 5.3.0 | SIL OFL 1.1 |

檔案由上述套件原樣複製（未修改），授權全文與版權見專案根目錄 `THIRD_PARTY_NOTICES.md`。
更新方式：升級套件後重新複製同名檔案，並更新此表的版本。
